import "server-only";

import { ENGINE_VERSION } from "@workhouse/protocol";

import { readConfigText } from "../workspace/sources";
import { sshExec } from "../kernel/launchers/ssh2";
import { awsSettings } from "./awsSettings";
import { bucketsOf } from "./buckets";
import { AwsCloud } from "./cloud/aws";
import type { CloudApi } from "./cloud/api";
import { ClusterService } from "./clusters";
import { dataDir, Store } from "./store";

/**
 * The Studio's cluster service (one per server process). "Local" (kernels
 * on the Studio's own machine) exists in development only: hosted, the
 * Studio runs kernels on clusters.
 */

function localCompute(): boolean {
  const flag = process.env.WORKHOUSE_LOCAL_COMPUTE;
  if (flag !== undefined) return flag !== "0" && flag.toLowerCase() !== "false";
  return !process.env.RENDER;
}

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
    dataBuckets: async () => bucketsOf(await readConfigText()),
    localCompute: localCompute(),
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

const globalForClusters = globalThis as unknown as { __workhouseClusters?: ClusterService };

/** Survives module reloads in development. */
export const clusters: ClusterService = (globalForClusters.__workhouseClusters ??= create());

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
