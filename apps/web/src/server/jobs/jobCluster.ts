import "server-only";

import { JOB_CLUSTER, type JobSpec } from "@/lib/jobs";

import { MAX_HOURS } from "../compute/instanceTypes";
import { clusters } from "../compute/service";
import { LOCAL_CLUSTER } from "../compute/types";
import type { ClusterLease, ClusterRef } from "./orchestrator";

/**
 * The cluster of a job run: a new one for the run (terminated after it), or
 * a named one (started if needed, left running). All the run's tasks share it.
 */

const CLUSTER_WAIT_MS = 20 * 60_000;

function abortReason(signal: AbortSignal): string {
  return typeof signal.reason === "string" ? signal.reason : "cancelled";
}

/** Wait until a cluster runs (starting it when it is terminated). */
async function runningCluster(id: string, signal: AbortSignal, log: (t: string) => void): Promise<void> {
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
    if (signal.aborted) throw new Error(abortReason(signal));
    const now = clusters.get(id)?.runtime;
    if (now?.state === "running") return;
    if (!now || now.state === "error" || now.state === "terminated") throw new Error(`cluster could not start: ${now?.error ?? now?.phase ?? "gone"}`);
    if (now.phase && now.phase !== phase) log(`cluster: ${(phase = now.phase)}`);
    if (Date.now() > until) throw new Error("the cluster took too long to start");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export function jobClusterLease(spec: JobSpec, runId: string, log: (t: string) => void): ClusterLease {
  let made: string | null = null;
  return {
    async acquire(signal: AbortSignal): Promise<ClusterRef> {
      if (spec.cluster === JOB_CLUSTER) {
        const c = clusters.create({
          name: `job-${runId}`.slice(0, 40),
          instanceType: spec.instanceType ?? undefined,
          // the run's own watchdog: no longer than the job's timeout (plus the boot)
          autoTerminateMinutes: Math.max(5, Math.min(spec.timeoutMinutes, 24 * 60)),
          // the run's hard limit: its timeout plus the boot, rounded up to whole hours
          maxHours: Math.min(MAX_HOURS, Math.ceil((spec.timeoutMinutes + 15) / 60)),
          job: runId,
        });
        made = c.id;
        log(`made cluster ${c.name} (${c.instanceType})`);
        await runningCluster(c.id, signal, log);
        return { id: c.id, name: c.name };
      }
      const named = clusters.views().find((c) => !c.job && (c.name.toLowerCase() === spec.cluster.toLowerCase() || c.id === spec.cluster));
      if (!named) throw new Error(`there is no cluster named ${spec.cluster}`);
      await runningCluster(named.id, signal, log);
      return { id: named.id, name: named.name };
    },
    async release(): Promise<void> {
      if (made) await clusters.terminate(made, "job run finished");
    },
  };
}
