import "server-only";

import path from "node:path";

import type { NotebookView, ParamsOf, ResultOf, WidgetValue } from "@iara/protocol";

import { isWithin, movedPath } from "@/lib/paths";

import type { Activity } from "../compute/clusters";
import { instanceType, memoryLimitBytes } from "../compute/instanceTypes";
import { cloudRegion, clusters } from "../compute/service";
import { dataDir } from "../compute/store";
import { LOCAL_CLUSTER } from "../compute/types";
import { diskCacheEnv, KERNEL_HOME, KERNEL_USER, SPILL_DIR, VENV, WORKSPACE_DIR } from "../compute/userData";
import { config, type StudioConfig } from "../config";
import { bucketKeys, bucketProxy, proxyEnv, teamBucketOf } from "../storage/bucketProxy";
import { catalogRegion } from "../workspace/catalogStore";
import { exists } from "../workspace/files";
import { kernelConfigText, readNotebookSource, writeNotebookSource } from "../workspace/sources";
import { bootstrap } from "./bootstrap";
import { KernelClient, KernelError } from "./client";
import { ASSISTANT_KERNEL, dashboardKernel, jobKernel, type KernelKey, notebookKernel, notebookPath, WORKSPACE_KERNEL } from "./keys";
import { localLauncher } from "./launchers/local";
import { remoteCommand } from "./launchers/remoteCommand";
import { ssh2Transport, sshExec } from "./launchers/ssh2";
import type { Launcher } from "./launchers/types";

/** What the metadata kernel answers: catalog reads that touch table logs, footers and schemas (never the rows), and notebook sources parsed or written, never run. */
export const METADATA_METHODS = ["catalog.list", "catalog.table", "catalog.history", "catalog.schema", "sql.explain", "notebook.parse", "notebook.render", "notebook.template"] as const;
export type MetadataMethod = (typeof METADATA_METHODS)[number];

/** What the serving kernel answers: queries over the stored extracts of dashboards, which the Studio builds itself (never a user's SQL beside the bucket keys it is given). */
export const SERVING_METHODS = ["sql.run", "result.page", "result.chart"] as const;
export type ServingMethod = (typeof SERVING_METHODS)[number];

/** The kernels the Studio runs itself, apart from the cluster kernels. */
type OwnKernel = "metadata" | "serving";

/** how long saves to a renamed notebook's old path follow it to the new one */
const RENAME_GRACE_MS = 60_000;

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
  /** the cluster of each job run's or dashboard's kernel */
  private readonly pinned = new Map<KernelKey, string>();
  /** notebook kernels whose notebook is open in the kernel */
  private readonly opened = new WeakSet<KernelClient>();
  private readonly clusterOf = new WeakMap<KernelClient, string>();
  /** notebooks that moved: old path -> new path and when (late saves of old editors follow them for a while) */
  private readonly renamed = new Map<string, { to: string; at: number }>();
  /** widget values by notebook: a restarted kernel opens its notebook with them (kernels forget values) */
  private readonly widgetValues = new Map<string, Record<string, WidgetValue>>();
  private chain: Promise<unknown> = Promise.resolve();
  /** the metadata and serving kernels, kept apart from the cluster kernels (no cluster, no status row), each with the catalog it was last given */
  private readonly own = new Map<OwnKernel, { kernel: KernelClient; toml: string | null }>();
  /** puts the team bucket's keys in the proxy of a cluster's machine (see storage/bucketProxy) */
  private readonly ensureProxy = bucketProxy({
    exec: (clusterId, command, stdin) => sshExec(clusters.endpoint(clusterId), command, 30_000, stdin),
    machine: (clusterId) => clusters.get(clusterId)?.runtime.instanceId,
    keys: () => bucketKeys(),
  });

  constructor(private readonly cfg: StudioConfig) {
    setInterval(() => this.reapIdle(), 60_000).unref();
    clusters.onTerminate((id) => this.stopCluster(id));
    clusters.activityFrom((id) => this.activity(id));
  }

  /** The cluster a kernel runs on: its notebook's attachment, else the default cluster. */
  clusterFor(key: KernelKey): string {
    const job = this.pinned.get(key);
    if (job) return job;
    if (key.startsWith("job:")) throw new KernelError("NoCluster", "the job run has no cluster");
    const id = clusters.clusterOf(notebookPath(key));
    if (!id) throw new KernelError("NoCluster", "there is no cluster to run on: create one on the Compute page");
    return id;
  }

  private launcher(clusterId: string): Launcher {
    if (clusterId === LOCAL_CLUSTER) return localLauncher(this.cfg);
    const c = clusters.get(clusterId);
    const endpoint = clusters.endpoint(clusterId); // throws while the cluster is not running
    const type = c && instanceType(c.instanceType);
    // the team bucket (if any) is reached through the machine's proxy, which holds the keys; the kernel has none
    const team = teamBucketOf(this.cfg, catalogRegion());
    // the cluster's own variables first: the system ones win
    const env: Record<string, string> = {
      ...c?.env,
      AWS_REGION: cloudRegion() ?? "us-east-1",
      IARA_SPILL_DIR: SPILL_DIR,
      ...(c && diskCacheEnv(c.volumeGb)),
      ...(team ? proxyEnv(team.region) : {}),
    };
    if (type) env.IARA_MEMORY_LIMIT = String(memoryLimitBytes(type));
    const command = remoteCommand({ user: KERNEL_USER, home: KERNEL_HOME, python: `${VENV}/bin/python`, workspace: WORKSPACE_DIR, env });
    return {
      name: c?.name ?? clusterId,
      localRoot: null,
      start: () => ssh2Transport(endpoint, command, team ? this.ensureProxy(clusterId) : undefined),
    };
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

  /** The assistant's kernel (its AI tools' queries), on the default cluster. */
  forAssistant(): KernelClient {
    return this.get(ASSISTANT_KERNEL);
  }

  /** A kernel the Studio runs itself, started on first use and again when it died, given the catalog whenever the Studio's copy changed. */
  private async ownKernel(name: OwnKernel, env?: Record<string, string>): Promise<KernelClient> {
    let own = this.own.get(name);
    if (!own?.kernel.alive) {
      const launcher = localLauncher(this.cfg, env);
      own = { kernel: new KernelClient({ transport: launcher.start(name), label: name, localRoot: launcher.localRoot, bootstrap }), toml: null };
      this.own.set(name, own);
    }
    const toml = await kernelConfigText("local");
    if (toml !== own.toml) {
      await own.kernel.request("workspace.configure", { toml });
      own.toml = toml;
    }
    return own.kernel;
  }

  /**
   * Catalog reads (tables, a table's details and history, the columns, query
   * plans) in a kernel the Studio runs itself, so they need no cluster. Only
   * METADATA_METHODS ever reach it: no user code runs beside the bucket keys
   * it is given. It reads the catalog again whenever the Studio's copy changed.
   */
  async metadata<M extends MetadataMethod>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    if (!METADATA_METHODS.includes(method)) throw new KernelError("NotMetadata", `${method} is not a catalog read`);
    return (await this.ownKernel("metadata")).request(method, params);
  }

  /**
   * Queries over the stored extracts of dashboards (and the pages and charts
   * of their results) in a kernel the Studio runs itself, so a viewer waits
   * for no cluster. Only SERVING_METHODS ever reach it, and never an `allow`:
   * a restricted context refuses to read files, and the SQL sent here is built
   * by the Studio (a read of an extract, narrowed by the viewer's filters), never
   * a user's. No user code runs beside the bucket keys it is given, so it
   * starts in Docker without IARA_LOCAL_COMPUTE as the metadata kernel does.
   * Its engine keeps what it reads from the bucket on local disk
   * (IARA_DISK_CACHE_DIR): a version of an extract is never rewritten, so that
   * cache is never stale.
   */
  async serving<M extends ServingMethod>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    if (!SERVING_METHODS.includes(method)) throw new KernelError("NotServing", `${method} cannot be served from an extract`);
    if ((params as { allow?: unknown }).allow !== undefined) throw new KernelError("NotServing", "the serving kernel takes no read grants: it only runs the Studio's own SQL");
    // 2 GB, not the engine's 10 GB default: it shares the Studio's disk
    const env = { IARA_DISK_CACHE_DIR: path.join(dataDir(), "cache", "extracts"), IARA_DISK_CACHE_MB: "2048" };
    return (await this.ownKernel("serving", env)).request(method, params);
  }

  /** A kernel of its own for a task of a job run (`id`: `<run>:<task>`), on the run's cluster (its activity keeps the cluster up). */
  forJob(id: string, clusterId: string): KernelClient {
    const key = jobKernel(id);
    this.pinned.set(key, clusterId);
    return this.get(key);
  }

  endJob(id: string): void {
    const key = jobKernel(id);
    this.restart(key);
    this.pinned.delete(key);
  }

  /** A dashboard's kernel, on `clusterId` (none: the default cluster). */
  forDashboard(id: string, clusterId?: string): KernelClient {
    const key = dashboardKernel(id);
    if (clusterId) this.pinned.set(key, clusterId);
    else this.pinned.delete(key);
    return this.get(key);
  }

  /** What the notebook's widgets hold now (from the kernel), for when its kernel restarts. */
  rememberWidgets(path: string, values: Record<string, WidgetValue>): void {
    const at = this.currentPath(path);
    // merged: after a restart the kernel only reports the widgets its cells have defined again
    this.widgetValues.set(at, { ...this.widgetValues.get(at), ...values });
  }

  /** Run notebook file operations (saves, renames, deletes) one at a time. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /** Where a notebook is now (following renames). */
  currentPath(path: string): string {
    for (let i = 0; i < 16; i++) {
      const r = this.renamed.get(path);
      if (!r) break;
      // only editors still open on the old path save late; later, the old path is free for a new file
      if (Date.now() - r.at > RENAME_GRACE_MS) {
        this.renamed.delete(path);
        break;
      }
      path = r.to;
    }
    return path;
  }

  /** The kernel of a notebook, with the notebook open in it (created first when asked). */
  async notebook(path: string, create = false): Promise<{ kernel: KernelClient; view: NotebookView }> {
    if (create) this.renamed.delete(path);
    else path = this.currentPath(path);
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
      view = await kernel.request("notebook.open", { path, source, widgets: this.widgetValues.get(path) });
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
      await kernel.request("notebook.open", { path, source, widgets: this.widgetValues.get(path) });
      this.opened.add(kernel);
    }
    return kernel;
  }

  /** Run a notebook on another cluster (its kernel restarts there on next use). */
  attach(path: string, clusterId: string): void {
    clusters.attach(path, clusterId);
    this.restart(notebookKernel(path));
  }

  /** Run a notebook on the default cluster from now on (its kernel restarts there on next use). */
  detach(path: string): void {
    clusters.detach(path);
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
      this.renamed.set(path!, { to: next, at: Date.now() });
      const widgets = this.widgetValues.get(path!);
      if (widgets) {
        this.widgetValues.delete(path!);
        this.widgetValues.set(next, widgets);
      }
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

  /**
   * Restart a kernel and start it again at once: a notebook's reopens its
   * notebook, the workspace kernel boots. A job run's kernel is not restarted
   * (its run would lose its state).
   */
  async restartNow(key: KernelKey): Promise<void> {
    if (notebookPath(key) === null && key !== WORKSPACE_KERNEL && key !== ASSISTANT_KERNEL) {
      throw new KernelError("JobKernel", "a job run's kernel cannot be restarted: cancel the run instead");
    }
    this.restart(key);
    const path = notebookPath(key);
    if (path !== null) await this.notebookForRun(path);
    else await this.get(key).ready;
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

  /** The live kernels on a cluster. */
  onCluster(clusterId: string): KernelStatus[] {
    return this.status().filter((k) => k.alive && k.cluster === clusterId);
  }

  /** The stderr tail of each live kernel on a cluster. */
  stderrOn(clusterId: string): { key: KernelKey; lines: string[] }[] {
    return [...this.kernels.entries()].filter(([, k]) => k.alive && this.clusterOf.get(k) === clusterId).map(([key, k]) => ({ key, lines: k.stderr }));
  }

  private reapIdle(): void {
    const limit = this.cfg.idleMinutes * 60_000;
    for (const [key, k] of this.kernels) {
      if (!k.alive || (!k.busy && Date.now() - k.lastUsed > limit)) {
        k.shutdown();
        this.kernels.delete(key);
      }
    }
    for (const [name, { kernel }] of this.own) {
      if (!kernel.alive || (!kernel.busy && Date.now() - kernel.lastUsed > limit)) {
        kernel.shutdown();
        this.own.delete(name);
      }
    }
  }

  shutdownAll(): void {
    for (const k of this.kernels.values()) k.shutdown(200);
    this.kernels.clear();
    for (const { kernel } of this.own.values()) kernel.shutdown(200);
    this.own.clear();
  }
}

const globalForKernels = globalThis as unknown as { __iaraKernels?: KernelManager };

/** Survives module reloads in development. */
export const kernels: KernelManager = (globalForKernels.__iaraKernels ??= new KernelManager(config));
