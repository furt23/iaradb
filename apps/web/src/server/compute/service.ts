import "server-only";

import path from "node:path";

import { ENGINE_VERSION } from "@iara/protocol";

import { config } from "../config";
import { teamBucketOf } from "../storage/bucketProxy";
import { catalogRegion } from "../workspace/catalogStore";
import { sshExec } from "../kernel/launchers/ssh2";
import { awsSettings } from "./awsSettings";
import { AwsCloud } from "./cloud/aws";
import type { CloudApi } from "./cloud/api";
import { ClusterService } from "./clusters";
import { ClusterEventLog, diskEventFiles } from "./events";
import { localComputeEnabled } from "./localCompute";
import { dataDir, Store } from "./store";

/**
 * The Studio's cluster service (one per server process). "Local" (kernels
 * on the Studio's own machine) exists in development only, or with
 * `IARA_LOCAL_COMPUTE=1`: hosted, the Studio runs kernels on clusters.
 */

let cloud: CloudApi | null | undefined;

function cloudApi(): CloudApi | null {
  if (cloud === undefined) {
    const settings = awsSettings();
    cloud = settings ? new AwsCloud(settings) : null;
  }
  return cloud;
}

function create(): ClusterService {
  const svc = new ClusterService({
    store: new Store(dataDir()),
    cloud: cloudApi,
    exec: sshExec,
    engineVersion: ENGINE_VERSION,
    teamBucket: () => teamBucketOf(config, catalogRegion()),
    localCompute: localComputeEnabled(),
    events: new ClusterEventLog({ dir: path.join(dataDir(), "cluster-events"), files: diskEventFiles }),
  });
  svc.resume();
  // auto-termination and machines that went away on their own
  setInterval(() => {
    void svc
      .reconcile()
      .then(() => svc.reap())
      .catch((e: Error) => console.error(`[clusters] ${e.message}`));
  }, 60_000).unref();
  return svc;
}

const globalForClusters = globalThis as unknown as { __iaraClusters?: ClusterService };

/** Survives module reloads in development. */
export const clusters: ClusterService = (globalForClusters.__iaraClusters ??= create());

export function cloudConfigured(): boolean {
  return cloudApi() !== null;
}

export function cloudRegion(): string | null {
  return cloudApi()?.region ?? null;
}

/** Whether the engine of this Studio's version was published for clusters (null: unknown). */
export async function enginePublished(): Promise<string | null> {
  const c = cloudApi();
  return c ? c.engineWheel(ENGINE_VERSION) : null;
}
