import "server-only";

import type { CatalogChange, CellOutput, RunResult } from "@iara/protocol";

import { splitQuery } from "@/features/queries/queryHeader";
import { detectParams, mergeSpecs, type ParamRaw, resolveParams } from "@/features/queries/queryParams";
import { splitStatements } from "@/lib/sqlStatements";

import type { KernelClient } from "../kernel/client";
import { kernels } from "../kernel/manager";
import { applyCatalogChanges } from "../workspace/catalogChanges";
import { readNotebookSource } from "../workspace/sources";
import { readSqlFile } from "../workspace/sqlFiles";
import type { TaskInput, TaskOutcome } from "./orchestrator";

/**
 * Running one task of a job: its notebook or query file, in a kernel of its
 * own (`<run>:<task>`) on the run's cluster. The kernel always ends with the
 * task. The task's `timeoutMinutes` fails it; an abort of `signal` cancels it.
 */

class Interrupted extends Error {}

function outputText(o: CellOutput | null): string {
  if (!o) return "";
  if (o.type === "error") return `${o.ename}: ${o.evalue}`;
  if (o.type === "table") return `${o.result.num_rows} rows × ${o.result.columns.length} columns`;
  return "";
}

async function runNotebook(kernel: KernelClient, input: TaskInput, changes: CatalogChange[]): Promise<string> {
  const { target } = input.task;
  const { log } = input;
  const source = await readNotebookSource(target);
  // the merged params preset the notebook's widgets (a widget takes its param as text and coerces it)
  await kernel.request("notebook.open", { path: target, source, widgets: input.params });
  const failed: string[] = [];
  const result: RunResult = await kernel.request("notebook.run", { cells: null, cell_ids: null }, (event, data) => {
    if (event === "cell.stream") log((data as { text: string }).text.replace(/\n$/, ""));
    else if (event === "catalog.changed") changes.push(data as CatalogChange);
    else if (event === "cell.state") {
      const s = data as { cell_id: string; status: string; output: CellOutput | null; elapsed_ms: number | null };
      if (s.status === "error") {
        failed.push(s.cell_id);
        log(`cell ${s.cell_id} failed: ${outputText(s.output)}`);
      } else if (s.status === "done") {
        const out = outputText(s.output);
        log(`cell ${s.cell_id} done${s.elapsed_ms !== null ? ` in ${Math.round(s.elapsed_ms)} ms` : ""}${out ? ` · ${out}` : ""}`);
      }
    }
  });
  if (result.interrupted) throw new Interrupted("interrupted");
  if (failed.length) throw new Error(`${failed.length} cell(s) failed (${failed.join(", ")})`);
  return `${result.ran.length} cells ran`;
}

async function runQueries(kernel: KernelClient, input: TaskInput, changes: CatalogChange[]): Promise<string> {
  const { target } = input.task;
  const { text } = await readSqlFile(target);
  const { body, params: saved } = splitQuery(text);
  const statements = splitStatements(body);
  if (!statements.length) throw new Error(`${target} holds no statement`);
  // the job's values for the query's parameters, else the defaults of its header
  const given: Record<string, ParamRaw> = {};
  for (const [k, v] of Object.entries(input.params ?? {})) given[k] = typeof v === "boolean" ? v : String(v);
  for (const [i, query] of statements.entries()) {
    const { query: values, missing } = resolveParams(mergeSpecs(detectParams(query), saved), given);
    if (missing.length) throw new Error(`${target}: no value for parameter ${missing.map((m) => `:${m}`).join(", ")}`);
    const out = await kernel.request("sql.run", { query, source: `job ${input.jobId}`, ...values }, (event, data) => {
      if (event === "catalog.changed") changes.push(data as CatalogChange);
    });
    input.log(`statement ${i + 1}/${statements.length}: ${outputText(out)}`);
  }
  return `${statements.length} statement(s) ran`;
}

function cancelReason(signal: AbortSignal): string {
  return typeof signal.reason === "string" ? signal.reason : "cancelled";
}

/** Run one task on the run's cluster; never throws. */
export async function runTask(input: TaskInput): Promise<TaskOutcome> {
  const { task, signal } = input;
  const changes: CatalogChange[] = [];
  const kernelId = `${input.runId}:${task.key}`;
  let kernel: KernelClient | undefined;
  let timedOut = false;
  const interrupt = () => void kernel?.request("interrupt", {}).catch(() => {});
  const timer =
    task.timeoutMinutes === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          interrupt();
        }, task.timeoutMinutes * 60_000);
  signal.addEventListener("abort", interrupt, { once: true });
  try {
    if (signal.aborted) return { status: "cancelled", error: cancelReason(signal) };
    kernel = kernels.forJob(kernelId, input.cluster.id);
    const summary = task.target.toLowerCase().endsWith(".sql") ? await runQueries(kernel, input, changes) : await runNotebook(kernel, input, changes);
    if (timedOut) throw new Error(`timed out after ${task.timeoutMinutes} min`);
    if (signal.aborted) return { status: "cancelled", error: cancelReason(signal) };
    return { status: "succeeded", summary };
  } catch (e) {
    if (timedOut) return { status: "failed", error: `timed out after ${task.timeoutMinutes} min` };
    if (signal.aborted || e instanceof Interrupted) return { status: "cancelled", error: cancelReason(signal) };
    return { status: "failed", error: (e as Error).message };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", interrupt);
    await applyCatalogChanges(changes, kernel ?? null).catch((e: Error) => input.log(`catalog not updated: ${e.message}`));
    kernels.endJob(kernelId);
  }
}
