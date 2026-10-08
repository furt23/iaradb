import "server-only";

import type { NotebookView } from "@workhouse/protocol";

import { isWithin, movedPath } from "@/lib/paths";

import type { Activity } from "../compute/clusters";
import { instanceType, memoryLimitBytes } from "../compute/instanceTypes";
import { cloudRegion, clusters } from "../compute/service";
import { LOCAL_CLUSTER } from "../compute/types";
import { SPILL_DIR, VENV } from "../compute/userData";
import { config, type StudioConfig } from "../config";
import { exists } from "../workspace/files";
import { readNotebookSource, writeNotebookSource } from "../workspace/sources";
import { bootstrap } from "./bootstrap";
import { KernelClient, KernelError } from "./client";
import { notebookKernel, notebookPath, WORKSPACE_KERNEL, type KernelKey } from "./keys";
import { localLauncher } from "./launchers/local";
import { remoteCommand } from "./launchers/remoteCommand";
import { ssh2Transport } from "./launchers/ssh2";
import type { Launcher } from "./launchers/types";

export interface KernelStatus {
  key: KernelKey;
  cluster: string | undefined;
  pid: number | undefined;
  alive: boolean;
  busy: boolean;
  startedAt: number;
  lastUsed: number;
}

/**
 * Kernel processes by key, each on its notebook's cluster (the workspace
 * kernel, for the catalog and the SQL editor, on the default cluster). The
 * Studio owns the notebooks: kernels receive their source and hand back
 * what to write.
 */
export class KernelManager {
  private readonly kernels = new Map<KernelKey, KernelClient>();
  /** notebook kernels whose notebook is open in the kernel */
  private readonly opened = new WeakSet<KernelClient>();
  private readonly clusterOf = new WeakMap<KernelClient, string>();
  /** notebooks that moved: old path -> new path (late saves of old editors follow them) */
  private readonly renamed = new Map<string, string>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly cfg: StudioConfig) {
    setInterval(() => this.reapIdle(), 60_000).unref();
    clusters.onTerminate((id) => this.stopCluster(id));
    clusters.activityFrom((id) => this.activity(id));
  }

  /** The cluster a kernel runs on: its notebook's attachment, else the default cluster. */
  clusterFor(key: KernelKey): string {
    const id = clusters.clusterOf(notebookPath(key));
    if (!id) throw new KernelError("NoCluster", "there is no cluster to run on: create one on the Compute page");
    return id;
  }

  private launcher(clusterId: string): Launcher {
    if (clusterId === LOCAL_CLUSTER) return localLauncher(this.cfg);
    const c = clusters.get(clusterId);
    const endpoint = clusters.endpoint(clusterId); // throws while the cluster is not running
    const type = c && instanceType(c.instanceType);
    const env: Record<string, string> = { AWS_REGION: cloudRegion() ?? "us-east-1", WORKHOUSE_SPILL_DIR: SPILL_DIR };
    if (type) env.WORKHOUSE_MEMORY_LIMIT = String(memoryLimitBytes(type));
    const command = remoteCommand({ python: `${VENV}/bin/python`, workspace: "~/workspace", env });
    return { name: c?.name ?? clusterId, localRoot: null, start: () => ssh2Transport(endpoint, command) };
  }

  get(key: KernelKey): KernelClient {
    const cluster = this.clusterFor(key);
    let k = this.kernels.get(key);
    if (k?.alive && this.clusterOf.get(k) !== cluster) {
      // the notebook was attached elsewhere: a new kernel there
      k.shutdown(200);
      k = undefined;
    }
    if (!k || !k.alive) {
      const launcher = this.launcher(cluster);
      k = new KernelClient({ transport: launcher.start(key), label: `${launcher.name} ${key}`, localRoot: launcher.localRoot, bootstrap });
      this.clusterOf.set(k, cluster);
      this.kernels.set(key, k);
    }
    return k;
  }

  /** A running kernel (no new one is started). */
  existing(key: KernelKey): KernelClient | undefined {
    const k = this.kernels.get(key);
    return k?.alive ? k : undefined;
  }

  workspace(): KernelClient {
    return this.get(WORKSPACE_KERNEL);
  }

  /** Run notebook file operations (saves, renames, deletes) one at a time. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /** Where a notebook is now (following renames). */
  currentPath(path: string): string {
    for (let i = 0; i < 16 && this.renamed.has(path); i++) path = this.renamed.get(path)!;
    return path;
  }

  /** The kernel of a notebook, with the notebook open in it (created first when asked). */
  async notebook(path: string, create = false): Promise<{ kernel: KernelClient; view: NotebookView }> {
    path = this.currentPath(path);
    let view: NotebookView;
    let kernel: KernelClient;
    if (create) {
      if (await exists(path)) throw new Error(`${path} already exists`);
      clusters.ensureAttached(path);
      kernel = this.get(notebookKernel(path));
      const { source, ...created } = await kernel.request("notebook.create", { path, persist: false });
      await writeNotebookSource(path, source);
      view = created;
    } else {
      const source = await readNotebookSource(path); // no kernel for a notebook that does not exist
      clusters.ensureAttached(path);
      kernel = this.get(notebookKernel(path));
      view = await kernel.request("notebook.open", { path, source });
    }
    this.opened.add(kernel);
    return { kernel, view };
  }

  /** A notebook kernel for running: (re)opens the notebook after a restart. */
  async notebookForRun(path: string): Promise<KernelClient> {
    path = this.currentPath(path);
    const key = notebookKernel(path);
    const open = this.kernels.get(key);
    if (open?.alive && this.opened.has(open) && this.clusterOf.get(open) === this.clusterFor(key)) return open;
    const source = await readNotebookSource(path);
    clusters.ensureAttached(path);
    const kernel = this.get(key);
    if (!this.opened.has(kernel)) {
      await kernel.request("notebook.open", { path, source });
      this.opened.add(kernel);
    }
    return kernel;
  }

  /** Run a notebook on another cluster (its kernel restarts there on next use). */
  attach(path: string, clusterId: string): void {
    clusters.attach(path, clusterId);
    this.restart(notebookKernel(path));
  }

  /** Notebooks whose files moved from `from` to `to` (a file or a folder) keep their kernels, state and cluster. */
  async moved(from: string, to: string): Promise<void> {
    clusters.moved((p) => movedPath(p, from, to));
    for (const [key, kernel] of [...this.kernels]) {
      const path = notebookPath(key);
      const next = path === null ? null : movedPath(path, from, to);
      if (next === null) continue;
      this.kernels.delete(key);
      this.kernels.set(notebookKernel(next), kernel);
      this.renamed.set(path!, next);
      if (kernel.alive && this.opened.has(kernel)) await kernel.request("notebook.rename", { path: next });
    }
  }

  /** Stop the kernels of notebooks at or under `path` (they are being deleted). */
  stopWithin(path: string): void {
    clusters.forget((p) => isWithin(p, path));
    for (const key of [...this.kernels.keys()]) {
      const nb = notebookPath(key);
      if (nb !== null && isWithin(nb, path)) this.restart(key);
    }
  }

  /** Stop every kernel of a cluster (it is being terminated). */
  stopCluster(clusterId: string): void {
    for (const [key, k] of [...this.kernels]) if (this.clusterOf.get(k) === clusterId) this.restart(key);
  }

  /** Kernel activity on a cluster, for its auto-termination. */
  activity(clusterId: string): Activity {
    const on = [...this.kernels.values()].filter((k) => k.alive && this.clusterOf.get(k) === clusterId);
    return { lastUsed: Math.max(0, ...on.map((k) => k.lastUsed)), busy: on.some((k) => k.busy) };
  }

  restart(key: KernelKey): void {
    this.kernels.get(key)?.shutdown(500);
    this.kernels.delete(key);
  }

  status(): KernelStatus[] {
    return [...this.kernels.entries()].map(([key, k]) => ({
      key,
      cluster: this.clusterOf.get(k),
      pid: k.pid,
      alive: k.alive,
      busy: k.busy,
      startedAt: k.startedAt,
      lastUsed: k.lastUsed,
    }));
  }

  private reapIdle(): void {
    const limit = this.cfg.idleMinutes * 60_000;
    for (const [key, k] of this.kernels) {
      if (!k.alive || (!k.busy && Date.now() - k.lastUsed > limit)) {
        k.shutdown();
        this.kernels.delete(key);
      }
    }
  }

  shutdownAll(): void {
    for (const k of this.kernels.values()) k.shutdown(200);
    this.kernels.clear();
  }
}

const globalForKernels = globalThis as unknown as { __workhouseKernels?: KernelManager };

/** Survives module reloads in development. */
export const kernels: KernelManager = (globalForKernels.__workhouseKernels ??= new KernelManager(config));
