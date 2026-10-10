import "server-only";

import type { CatalogChange, CellOutput, RunResult } from "@workhouse/protocol";

import { splitQuery } from "@/features/queries/queryHeader";
import { isFinished, JOB_CLUSTER, type JobRun, type JobSpec, type RunTrigger } from "@/lib/jobs";
import { splitStatements } from "@/lib/sqlStatements";

import { clusters } from "../compute/service";
import { LOCAL_CLUSTER } from "../compute/types";
import type { KernelClient } from "../kernel/client";
import { kernels } from "../kernel/manager";
import { applyCatalogChanges } from "../workspace/catalogChanges";
import { readNotebookSource } from "../workspace/sources";
import { readSqlFile } from "../workspace/sqlFiles";
import { appendLog, listRuns, saveRun } from "./runs";

/**
 * Running a job: get a cluster (a new one per run, or a named one, started
 * if needed), run the notebook or the query file in a kernel of its own,
 * log what happens, and leave nothing behind (the run's kernel, its cluster).
 */

const CLUSTER_WAIT_MS = 20 * 60_000;

interface Active {
  run: JobRun;
  kernel?: KernelClient;
  cancelled?: string;
}

const g = globalThis as { __workhouseJobRuns?: Map<string, Active> };
const active = (g.__workhouseJobRuns ??= new Map());

class RunCancelled extends Error {}

function update(a: Active, patch: Partial<JobRun>): void {
  a.run = { ...a.run, ...patch };
  saveRun(a.run);
}

function logger(run: JobRun) {
  return (text: string) => appendLog(run.job, run.id, `[${new Date().toISOString().slice(11, 19)}] ${text}\n`);
}

/** Wait until a cluster runs (starting it when it is terminated). */
async function runningCluster(id: string, a: Active, log: (t: string) => void): Promise<void> {
  if (id === LOCAL_CLUSTER) return;
  const c = clusters.get(id);
  if (!c) throw new Error(`the cluster is gone`);
  if (c.runtime.state !== "running") {
    log(`starting cluster ${c.name}`);
    clusters.start(id);
  }
  const until = Date.now() + CLUSTER_WAIT_MS;
  let phase = "";
  for (;;) {
    if (a.cancelled) throw new RunCancelled(a.cancelled);
    const now = clusters.get(id)?.runtime;
    if (now?.state === "running") return;
    if (!now || now.state === "error" || now.state === "terminated") throw new Error(`cluster could not start: ${now?.error ?? now?.phase ?? "gone"}`);
    if (now.phase && now.phase !== phase) log(`cluster: ${(phase = now.phase)}`);
    if (Date.now() > until) throw new Error("the cluster took too long to start");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** The cluster a run uses, and whether it was made for it. */
async function clusterFor(spec: JobSpec, a: Active, log: (t: string) => void): Promise<{ id: string; name: string; made: boolean }> {
  if (spec.cluster === JOB_CLUSTER) {
    const c = clusters.create({
      name: `job-${a.run.id}`.slice(0, 40),
      instanceType: spec.instanceType ?? undefined,
      // the run's own watchdog: no longer than the job's timeout (plus the boot)
      autoTerminateMinutes: Math.max(5, Math.min(spec.timeoutMinutes, 24 * 60)),
      job: a.run.id,
    });
    log(`made cluster ${c.name} (${c.instanceType})`);
    await runningCluster(c.id, a, log);
    return { id: c.id, name: c.name, made: true };
  }
  const named = clusters.views().find((c) => !c.job && (c.name.toLowerCase() === spec.cluster.toLowerCase() || c.id === spec.cluster));
  if (!named) throw new Error(`there is no cluster named ${spec.cluster}`);
  await runningCluster(named.id, a, log);
  return { id: named.id, name: named.name, made: false };
}

function outputText(o: CellOutput | null): string {
  if (!o) return "";
  if (o.type === "error") return `${o.ename}: ${o.evalue}`;
  if (o.type === "table") return `${o.result.num_rows} rows × ${o.result.columns.length} columns`;
  return "";
}

async function runNotebook(kernel: KernelClient, spec: JobSpec, log: (t: string) => void, changes: CatalogChange[]): Promise<string> {
  const source = await readNotebookSource(spec.target);
  await kernel.request("notebook.open", { path: spec.target, source });
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
  if (result.interrupted) throw new RunCancelled("interrupted");
  if (failed.length) throw new Error(`${failed.length} cell(s) failed (${failed.join(", ")})`);
  return `${result.ran.length} cells ran`;
}

async function runQueries(kernel: KernelClient, spec: JobSpec, log: (t: string) => void, changes: CatalogChange[]): Promise<string> {
  const { text } = await readSqlFile(spec.target);
  const statements = splitStatements(splitQuery(text).body);
  if (!statements.length) throw new Error(`${spec.target} holds no statement`);
  for (const [i, query] of statements.entries()) {
    const out = await kernel.request("sql.run", { query, source: `job ${spec.id}` }, (event, data) => {
      if (event === "catalog.changed") changes.push(data as CatalogChange);
    });
    log(`statement ${i + 1}/${statements.length}: ${outputText(out)}`);
  }
  return `${statements.length} statement(s) ran`;
}

async function execute(spec: JobSpec, a: Active): Promise<void> {
  const log = logger(a.run);
  const changes: CatalogChange[] = [];
  let cluster: { id: string; name: string; made: boolean } | null = null;
  const timeout = setTimeout(() => void cancel(a, `timed out after ${spec.timeoutMinutes} min`), spec.timeoutMinutes * 60_000);
  try {
    log(`run ${a.run.id} of ${spec.target} (${a.run.trigger})`);
    cluster = await clusterFor(spec, a, log);
    update(a, { status: "running", cluster: cluster.name });
    a.kernel = kernels.forJob(a.run.id, cluster.id);
    const summary = spec.target.toLowerCase().endsWith(".sql") ? await runQueries(a.kernel, spec, log, changes) : await runNotebook(a.kernel, spec, log, changes);
    if (a.cancelled) throw new RunCancelled(a.cancelled);
    log(`succeeded: ${summary}`);
    update(a, { status: "succeeded", summary, endedAt: Date.now() });
  } catch (e) {
    const why = a.cancelled ?? (e as Error).message;
    log(`${a.cancelled || e instanceof RunCancelled ? "cancelled" : "failed"}: ${why}`);
    update(a, { status: a.cancelled || e instanceof RunCancelled ? "cancelled" : "failed", error: why, endedAt: Date.now() });
  } finally {
    clearTimeout(timeout);
    await applyCatalogChanges(changes, a.kernel ?? null).catch((e: Error) => log(`catalog not updated: ${e.message}`));
    kernels.endJob(a.run.id);
    if (cluster?.made) await clusters.terminate(cluster.id, "job run finished").catch((e: Error) => log(`cluster not terminated: ${e.message}`));
    active.delete(a.run.id);
  }
}

async function cancel(a: Active, why: string): Promise<void> {
  if (isFinished(a.run.status) || a.cancelled) return;
  a.cancelled = why;
  await a.kernel?.request("interrupt", {}).catch(() => {});
}

/** The run of a job going on now, if any. */
export function activeRun(job: string): JobRun | undefined {
  return [...active.values()].find((a) => a.run.job === job)?.run;
}

/** Start a run (it goes on in the background); one run of a job at a time. */
export function startRun(spec: JobSpec, trigger: RunTrigger): JobRun {
  if (activeRun(spec.id)) throw new Error(`${spec.name} is already running`);
  const run: JobRun = {
    id: `r-${Date.now().toString(36)}-${Math.floor(Math.random() * 46656).toString(36)}`,
    job: spec.id,
    trigger,
    status: "starting",
    startedAt: Date.now(),
  };
  const a: Active = { run };
  active.set(run.id, a);
  saveRun(run);
  void execute(spec, a);
  return run;
}

export async function cancelRun(runId: string): Promise<void> {
  const a = active.get(runId);
  if (a) await cancel(a, "cancelled by hand");
}

/** Runs left "running" by a Studio that stopped mid-run. */
export function settleInterrupted(job: string): void {
  for (const r of listRuns(job)) {
    if (!isFinished(r.status) && !active.has(r.id)) saveRun({ ...r, status: "failed", error: "the Studio stopped during the run", endedAt: r.endedAt ?? Date.now() });
  }
}
