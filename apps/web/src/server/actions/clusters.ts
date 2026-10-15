"use server";

import { ENGINE_VERSION } from "@iara/protocol";

import type { StudioUser } from "../auth/access";
import { AuthError, requireUser } from "../auth/session";
import { ClusterError } from "../compute/clusters";
import type { ClusterEvent } from "../compute/events";
import { canManageCluster } from "../compute/permissions";
import { INSTANCE_TYPES } from "../compute/instanceTypes";
import { cloudConfigured, cloudRegion, clusters, enginePublished } from "../compute/service";
import type { ClusterView, InstanceType } from "../compute/types";
import { type KernelKey, normalizeRelative, parseKernelKey } from "../kernel/keys";
import { kernels } from "../kernel/manager";
import { attempt, type ActionResult } from "../result";

export interface ComputeOverview {
  clusters: ClusterView[];
  /** the Studio can create machines (AWS credentials are configured) */
  cloud: boolean;
  region: string | null;
  engineVersion: string;
  instanceTypes: InstanceType[];
}

/** The cluster views with `canManage` set for `user`. */
function viewsFor(user: StudioUser): ClusterView[] {
  return clusters.views().map((v) => ({ ...v, canManage: v.kind === "ec2" && canManageCluster(user, v.owner) }));
}

/** Only the owner or a team admin may change or delete a cluster; a cluster that does not exist is left to the service. */
function requireManage(user: StudioUser, id: string): void {
  const record = clusters.get(id);
  if (record && !canManageCluster(user, record.owner)) {
    throw new AuthError("forbidden", "only the cluster's owner or a team admin may change or delete it");
  }
}

let lastReconcile = 0;

/** Machines are checked at most every 10 s (for the pages that show them). */
async function reconcileOnce(): Promise<void> {
  if (Date.now() - lastReconcile <= 10_000) return;
  lastReconcile = Date.now();
  await clusters.reconcile().catch((e: Error) => console.error(`[clusters] ${e.message}`));
}

/** Clusters and their states (machines are checked at most every 10 s). */
export async function computeOverview(): Promise<ActionResult<ComputeOverview>> {
  return attempt(async () => {
    const user = await requireUser();
    await reconcileOnce();
    return { clusters: viewsFor(user), cloud: cloudConfigured(), region: cloudRegion(), engineVersion: ENGINE_VERSION, instanceTypes: INSTANCE_TYPES };
  });
}

/** Whether clusters can install this Studio's engine (the wheel was published). */
export async function engineStatus(): Promise<ActionResult<{ version: string; wheel: string | null }>> {
  return attempt(async () => {
    await requireUser();
    return { version: ENGINE_VERSION, wheel: await enginePublished() };
  });
}

export interface ClusterInput {
  name: string;
  instanceType: string;
  autoTerminateMinutes: number;
  volumeGb: number;
}

export async function createCluster(input: ClusterInput): Promise<ActionResult<{ id: string }>> {
  return attempt(async () => {
    const user = await requireUser();
    return { id: clusters.create({ ...input, owner: user.email || undefined }).id };
  });
}

export async function updateCluster(id: string, patch: Partial<ClusterInput>): Promise<ActionResult<{ id: string }>> {
  return attempt(async () => {
    requireManage(await requireUser(), id);
    return { id: clusters.update(id, patch).id };
  });
}

export async function startCluster(id: string): Promise<ActionResult<{ id: string }>> {
  return attempt(async () => {
    await requireUser();
    return { id: clusters.start(id).id };
  });
}

export async function terminateCluster(id: string): Promise<ActionResult<{ id: string }>> {
  return attempt(async () => {
    await requireUser();
    await clusters.terminate(id);
    return { id };
  });
}

export async function deleteCluster(id: string): Promise<ActionResult<{ id: string }>> {
  return attempt(async () => {
    requireManage(await requireUser(), id);
    clusters.remove(id);
    return { id };
  });
}

/** A copy of a cluster: same machine and limits, not started. */
export async function cloneCluster(id: string): Promise<ActionResult<{ id: string }>> {
  return attempt(async () => {
    const user = await requireUser();
    return { id: clusters.clone(id, user.email || undefined).id };
  });
}

/** The cluster a notebook runs on. */
export async function notebookCluster(path: string): Promise<ActionResult<{ cluster: string | null }>> {
  return attempt(async () => {
    await requireUser();
    return { cluster: clusters.clusterOf(normalizeRelative(path)) };
  });
}

/** Attach a notebook to a cluster (its kernel restarts there). */
export async function attachNotebook(path: string, clusterId: string): Promise<ActionResult<{ cluster: string }>> {
  return attempt(async () => {
    await requireUser();
    kernels.attach(normalizeRelative(path), clusterId);
    return { cluster: clusterId };
  });
}

/** The notebook runs on the default cluster from now on (its kernel restarts there on next use). */
export async function detachNotebook(path: string): Promise<ActionResult<{ cluster: string | null }>> {
  return attempt(async () => {
    await requireUser();
    const nb = normalizeRelative(path);
    kernels.detach(nb);
    return { cluster: clusters.clusterOf(nb) };
  });
}

/** The cluster of the SQL editor, the catalog and new notebooks. */
export async function setDefaultCluster(clusterId: string): Promise<ActionResult<{ cluster: string }>> {
  return attempt(async () => {
    await requireUser();
    clusters.setDefault(clusterId);
    // the workspace kernel moves on its next request
    return { cluster: clusterId };
  });
}

/** A kernel running on a cluster. */
export interface ClusterKernel {
  key: KernelKey;
  busy: boolean;
  startedAt: number;
  lastUsed: number;
}

export interface ClusterDetailView {
  cluster: ClusterView;
  /** newest first */
  events: ClusterEvent[];
  kernels: ClusterKernel[];
  createdAt: number | null;
}

/** A cluster's page: its state, event log and kernels. */
export async function clusterDetail(id: string): Promise<ActionResult<ClusterDetailView>> {
  return attempt(async () => {
    const user = await requireUser();
    await reconcileOnce();
    const cluster = viewsFor(user).find((c) => c.id === id);
    if (!cluster) throw new ClusterError("UnknownCluster", `unknown cluster ${id}`);
    return {
      cluster,
      events: clusters.eventsOf(id),
      kernels: kernels.onCluster(id).map((k) => ({ key: k.key, busy: k.busy, startedAt: k.startedAt, lastUsed: k.lastUsed })),
      createdAt: clusters.get(id)?.createdAt ?? null,
    };
  });
}

/** Stop one kernel (its next request starts a new one). */
export async function stopClusterKernel(key: string): Promise<ActionResult<null>> {
  return attempt(async () => {
    await requireUser();
    kernels.restart(parseKernelKey(key));
    return null;
  });
}

/** Restart one kernel and start it again at once. */
export async function restartClusterKernel(key: string): Promise<ActionResult<null>> {
  return attempt(async () => {
    await requireUser();
    await kernels.restartNow(parseKernelKey(key));
    return null;
  });
}
