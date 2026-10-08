"use server";

import { ENGINE_VERSION } from "@workhouse/protocol";

import { INSTANCE_TYPES } from "../compute/instanceTypes";
import { cloudConfigured, cloudRegion, clusters, enginePublished } from "../compute/service";
import type { ClusterView, InstanceType } from "../compute/types";
import { normalizeRelative } from "../kernel/keys";
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

let lastReconcile = 0;

/** Clusters and their states (machines are checked at most every 10 s). */
export async function computeOverview(): Promise<ActionResult<ComputeOverview>> {
  return attempt(async () => {
    if (Date.now() - lastReconcile > 10_000) {
      lastReconcile = Date.now();
      await clusters.reconcile().catch((e: Error) => console.error(`[clusters] ${e.message}`));
    }
    return { clusters: clusters.views(), cloud: cloudConfigured(), region: cloudRegion(), engineVersion: ENGINE_VERSION, instanceTypes: INSTANCE_TYPES };
  });
}

/** Whether clusters can install this Studio's engine (the wheel was published). */
export async function engineStatus(): Promise<ActionResult<{ version: string; wheel: string | null }>> {
  return attempt(async () => ({ version: ENGINE_VERSION, wheel: await enginePublished() }));
}

export interface ClusterInput {
  name: string;
  instanceType: string;
  autoTerminateMinutes: number;
  volumeGb: number;
}

export async function createCluster(input: ClusterInput): Promise<ActionResult<{ id: string }>> {
  return attempt(async () => ({ id: clusters.create(input).id }));
}

export async function updateCluster(id: string, patch: Partial<ClusterInput>): Promise<ActionResult<{ id: string }>> {
  return attempt(async () => ({ id: clusters.update(id, patch).id }));
}

export async function startCluster(id: string): Promise<ActionResult<{ id: string }>> {
  return attempt(async () => ({ id: clusters.start(id).id }));
}

export async function terminateCluster(id: string): Promise<ActionResult<{ id: string }>> {
  return attempt(async () => {
    await clusters.terminate(id);
    return { id };
  });
}

export async function deleteCluster(id: string): Promise<ActionResult<{ id: string }>> {
  return attempt(async () => {
    clusters.remove(id);
    return { id };
  });
}

/** The cluster a notebook runs on. */
export async function notebookCluster(path: string): Promise<ActionResult<{ cluster: string | null }>> {
  return attempt(async () => ({ cluster: clusters.clusterOf(normalizeRelative(path)) }));
}

/** Attach a notebook to a cluster (its kernel restarts there). */
export async function attachNotebook(path: string, clusterId: string): Promise<ActionResult<{ cluster: string }>> {
  return attempt(async () => {
    kernels.attach(normalizeRelative(path), clusterId);
    return { cluster: clusterId };
  });
}

/** The cluster of the SQL editor, the catalog and new notebooks. */
export async function setDefaultCluster(clusterId: string): Promise<ActionResult<{ cluster: string }>> {
  return attempt(async () => {
    clusters.setDefault(clusterId);
    // the workspace kernel moves on its next request
    return { cluster: clusterId };
  });
}
