import "server-only";

import type { CatalogChange, CellOutput, RunResult } from "@iara/protocol";

import { splitQuery } from "@/features/queries/queryHeader";
import { detectParams, mergeSpecs, type ParamRaw, resolveParams } from "@/features/queries/queryParams";
import { wantsExtract } from "@/lib/dashboards/extracts";
import type { PublishedDashboard, RenderResult } from "@/lib/dashboards/types";
import { splitStatements } from "@/lib/sqlStatements";

import { authMode, LOCAL_USER, studioUser } from "../auth/access";
import { refreshExtracts, servedExtracts } from "../dashboards/extractRefresh";
import { getPublished } from "../dashboards/publish";
import { dashboardSlug } from "../dashboards/refresh";
import { renderDashboard, type RunDeps } from "../dashboards/run";
import { audienceAllows, forgetSnapshots, saveSnapshot } from "../dashboards/snapshots";
import { readConfig } from "../dashboards/store";
import { readGrants, userAllow } from "../governance/store";
import type { KernelClient } from "../kernel/client";
import { kernels } from "../kernel/manager";
import { applyCatalogChanges } from "../workspace/catalogChanges";
import { readNotebookSource } from "../workspace/sources";
import { readSqlFile } from "../workspace/sqlFiles";
import type { TaskInput, TaskOutcome } from "./orchestrator";

/**
 * Running one task of a job: its notebook or query file, or the render of a
 * dashboard for a scheduled refresh (dashboards/refresh.ts), in a kernel
 * of its own (`<run>:<task>`) on the run's cluster. The kernel always ends with the
 * task. The task's `timeoutMinutes` fails it; an abort of `signal` cancels it.
 */

class Interrupted extends Error {}

function outputText(o: CellOutput | null): string {
  if (!o) return "";
  if (o.type === "error") return `${o.ename}: ${o.evalue}`;
  if (o.type === "table") return `${o.result.num_rows} rows × ${o.result.columns.length} columns`;
  if (o.type === "tables") return o.tables.map(outputText).join("; ");
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

/**
 * What the publisher may read now (null: everything): the identity of the
 * extracts' queries. A publisher who can no longer sign in reads nothing.
 */
function publisherAllow(p: PublishedDashboard): string[] | null {
  const user = authMode() === "off" ? LOCAL_USER : studioUser({ email: p.publishedBy, email_verified: true });
  return user ? userAllow(user) : [];
}

const counted = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/**
 * Refresh the published dashboard `dashboards/<slug>`: build the extracts of
 * its datasets with the publisher's grants, then, only when a dataset runs
 * live, render it for every user who can open it and store the renders, which
 * its viewers get at once from then on (extracts are read in milliseconds, so
 * a dashboard of extracts needs no stored render). `stopped` says the task was
 * cancelled or timed out: nothing is stored then.
 */
export async function refreshDashboard(kernel: Pick<KernelClient, "request">, input: TaskInput, stopped: () => boolean = () => false): Promise<string> {
  const { target } = input.task;
  const p = getPublished((await readConfig(dashboardSlug(target) ?? "")).id);
  if (!p) throw new Error(`${target} is not published`);
  // once stopped, the queries still to run fail at once
  const request: RunDeps["request"] = (method, params) => (stopped() ? Promise.reject(new Interrupted("interrupted")) : kernel.request(method, params));
  const source = `job ${input.jobId}`;
  const extracts = await refreshExtracts(p, { request, log: input.log, stopped, allow: publisherAllow(p), source });
  if (stopped()) throw new Interrupted("interrupted");
  const live = p.datasets.some((d) => !wantsExtract(d));
  if (!live && extracts.failed > 0 && extracts.built === 0) throw new Error("every extract failed");
  const parts = p.datasets.some(wantsExtract) ? [counted(extracts.built, "extract"), ...(extracts.failed ? [`${extracts.failed} failed`] : [])] : [];
  const renders: { allow: string[] | null; result: RenderResult }[] = [];
  if (live) {
    const audiences = audienceAllows(p, readGrants());
    if (!audiences.length) throw new Error(`${p.title} has no one to render for (IARA_ALLOWED_EMAILS and IARA_VIEWER_EMAILS name nobody who can open it)`);
    const served = await servedExtracts(p.id);
    let widgets = 0;
    let failed = 0;
    let firstError = "";
    for (const allow of audiences) {
      const result = await renderDashboard(p, {}, { request, redact: false, source, allow, extracts: served }, []);
      if (stopped()) throw new Interrupted("interrupted");
      const data = Object.entries(result.widgets);
      const errors = data.flatMap(([id, w]) => (w.kind === "error" ? [`widget ${id} failed: ${w.message}`] : []));
      widgets += data.length;
      failed += errors.length;
      firstError ||= errors[0] ?? "";
      input.log(`rendered for ${allow ? `${allow.length} granted ${allow.length === 1 ? "scope" : "scopes"}` : "everything"} · ${errors.length} of ${data.length} widgets failed`);
      for (const e of errors) input.log(e);
      renders.push({ allow, result });
    }
    if (failed > 0 && failed === widgets) throw new Error(`every widget failed (${firstError})`);
    parts.push(counted(renders.length, "render"));
  }
  // the renders of the audiences now, not of a past publish or a past set of users
  forgetSnapshots(p.id);
  for (const { allow, result } of renders) saveSnapshot(p, allow, result);
  return `dashboard ${p.title} refreshed (${parts.join(", ") || "no datasets"})`;
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
    const summary =
      dashboardSlug(task.target) !== null
        ? await refreshDashboard(kernel, input, () => timedOut || signal.aborted)
        : task.target.toLowerCase().endsWith(".sql")
          ? await runQueries(kernel, input, changes)
          : await runNotebook(kernel, input, changes);
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
