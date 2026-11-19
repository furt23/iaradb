import { type CloudApi, NOT_FOUND } from "./cloud/api";
import { ClusterError } from "./clusterError";
import { checkedEnv, checkedInitScript, checkedLibraries, checkedMaxHours, checkedTags } from "./clusterSettings";
import type { ClusterEvent, ClusterEventKind, ClusterEventLog } from "./events";
import { DEFAULT_AUTO_TERMINATE_MINUTES, DEFAULT_INSTANCE_TYPE, DEFAULT_MAX_HOURS, DEFAULT_VOLUME_GB, instanceType, MIN_AUTO_TERMINATE_MINUTES } from "./instanceTypes";
import type { Identity, StudioState } from "./store";
import { LOCAL_CLUSTER, MACHINE_FIELDS, type ClusterRecord, type ClusterRuntime, type ClusterView, type LibraryStatus } from "./types";
import { BOOT_LOG, FAILED_MARKER, INIT_LOG, KERNEL_HOME, KERNEL_USER, proxyUrlOf, READY_MARKER, type TeamBucket, userData, UV, VENV } from "./userData";

/**
 * On-demand compute clusters: a configuration the user creates once, and a
 * machine that exists only while the cluster runs. Start launches a machine
 * (engine from the artifacts bucket), Terminate releases it, and a cluster
 * without kernel activity for its auto-terminate time is terminated. Many
 * notebooks may attach to one cluster, each with its own kernel there.
 */

export interface StoreApi {
  read(): StudioState;
  update<T>(fn: (s: StudioState) => T): T;
  cluster(id: string): ClusterRecord | undefined;
  updateCluster(id: string, fn: (c: ClusterRecord) => void): ClusterRecord;
  identity(): Identity;
}

export interface SshEndpointLike {
  host: string;
  username: string;
  privateKey: string;
  hostKey?: string;
  onHostKey?: (fingerprint: string) => void;
}

export interface ClusterDeps {
  store: StoreApi;
  /** null when the Studio has no cloud credentials */
  cloud(): CloudApi | null;
  exec(ep: SshEndpointLike, command: string, timeoutMs?: number): Promise<{ code: number | null; stdout: string }>;
  engineVersion: string;
  /** the team bucket clusters reach through their machine's proxy (null: the Studio has none) */
  teamBucket(): TeamBucket | null;
  localCompute: boolean;
  /** what happened to each cluster */
  events: ClusterEventLog;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** how long to wait for a machine to become ready */
  bootTimeoutMs?: number;
}

export interface Activity {
  /** last kernel request on the cluster */
  lastUsed: number;
  /** a kernel request is running there now */
  busy: boolean;
}

export interface NewCluster {
  name: string;
  instanceType?: string;
  autoTerminateMinutes?: number;
  volumeGb?: number;
  job?: string;
  /** email of the member creating it */
  owner?: string;
  libraries?: string[];
  env?: Record<string, string>;
  initScript?: string;
  spot?: boolean;
  maxHours?: number;
  tags?: Record<string, string>;
}

/** What `ClusterService.update` changes (the machine fields only while the cluster is terminated). */
export type ClusterPatch = Omit<NewCluster, "job" | "owner">;

/** The lines of a machine log (see `ClusterService.logs`). */
export interface MachineLog {
  /** oldest first */
  lines: string[];
  unavailable?: string;
}

/** The reason a user's Terminate gives (the phase the UI shows while it goes on). */
const USER_STOP = "stopped by the user";
const SSH_USER = "ec2-user";
/** a machine powers itself off this long after the Studio would have terminated it */
const WATCHDOG_GRACE_MINUTES = 5;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const LOG_TIMEOUT_MS = 15_000;
const NAME_MAX = 40;

export class ClusterService {
  private readonly jobs = new Map<string, Promise<void>>();
  /** library installs on running machines (their failure never puts the cluster in error) */
  private readonly installs = new Map<string, Promise<void>>();
  private terminateHook: (id: string) => void = () => {};
  private activitySource: (id: string) => Activity = () => ({ lastUsed: 0, busy: false });

  constructor(private readonly d: ClusterDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private sleep(ms: number): Promise<void> {
    return (this.d.sleep ?? ((t) => new Promise((r) => setTimeout(r, t))))(ms);
  }

  /** Kernels on a cluster that goes away must stop (set by the kernel manager). */
  onTerminate(fn: (id: string) => void): void {
    this.terminateHook = fn;
  }

  /** Where kernel activity comes from (set by the kernel manager). */
  activityFrom(fn: (id: string) => Activity): void {
    this.activitySource = fn;
  }

  get localCompute(): boolean {
    return this.d.localCompute;
  }

  // -- configuration -----------------------------------------------------------

  get(id: string): ClusterRecord | undefined {
    return this.d.store.cluster(id);
  }

  defaultCluster(): string | null {
    const s = this.d.store.read();
    if (s.defaultCluster && (this.exists(s.defaultCluster))) return s.defaultCluster;
    return this.d.localCompute ? LOCAL_CLUSTER : (s.clusters.find((c) => !c.job)?.id ?? null);
  }

  private exists(id: string): boolean {
    return id === LOCAL_CLUSTER ? this.d.localCompute : this.d.store.cluster(id) !== undefined;
  }

  /** The cluster a notebook runs on (its attachment, else the default); null for none. */
  clusterOf(notebook: string | null): string | null {
    if (notebook) {
      const attached = this.d.store.read().attachments[notebook];
      if (attached && this.exists(attached)) return attached;
    }
    return this.defaultCluster();
  }

  /** A notebook opened for the first time stays on the cluster that was the default then. */
  ensureAttached(notebook: string): void {
    const s = this.d.store.read();
    const current = s.attachments[notebook];
    if (current && this.exists(current)) return;
    const def = this.defaultCluster();
    if (def) {
      this.d.store.update((x) => void (x.attachments[notebook] = def));
      this.noteAttachment(notebook, undefined, def);
    }
  }

  attach(notebook: string, clusterId: string): void {
    if (!this.exists(clusterId)) throw new ClusterError("UnknownCluster", `unknown cluster ${clusterId}`);
    const from = this.d.store.read().attachments[notebook];
    this.d.store.update((s) => void (s.attachments[notebook] = clusterId));
    this.noteAttachment(notebook, from, clusterId);
  }

  /** The notebook runs on the default cluster from now on. */
  detach(notebook: string): void {
    const from = this.d.store.read().attachments[notebook];
    if (!from) return;
    this.d.store.update((s) => {
      delete s.attachments[notebook];
    });
    this.log(from, "detached", `${notebook} detached`);
  }

  private noteAttachment(notebook: string, from: string | undefined, to: string): void {
    if (from === to) return;
    if (from) this.log(from, "detached", `${notebook} detached`);
    this.log(to, "attached", `${notebook} attached`);
  }

  /** Moved notebooks keep their clusters (`move` maps an old path to its new one, or null). */
  moved(move: (path: string) => string | null): void {
    this.d.store.update((s) => {
      for (const [path, id] of Object.entries(s.attachments)) {
        const next = move(path);
        if (next !== null && next !== path) {
          delete s.attachments[path];
          s.attachments[next] = id;
        }
      }
    });
  }

  /** Deleted notebooks lose their attachments. */
  forget(within: (path: string) => boolean): void {
    const gone: [string, string][] = [];
    this.d.store.update((s) => {
      for (const [path, id] of Object.entries(s.attachments)) {
        if (!within(path)) continue;
        delete s.attachments[path];
        gone.push([path, id]);
      }
    });
    for (const [path, id] of gone) this.log(id, "detached", `${path} deleted`);
  }

  setDefault(id: string): void {
    if (!this.exists(id)) throw new ClusterError("UnknownCluster", `unknown cluster ${id}`);
    this.d.store.update((s) => void (s.defaultCluster = id));
  }

  create(input: NewCluster): ClusterRecord {
    const rec = this.add(input);
    const job = input.job ? `, job run ${input.job}` : "";
    this.log(rec.id, "created", `${rec.instanceType}, ${rec.volumeGb} GB, ${rec.autoTerminateMinutes} min idle limit${rec.spot ? ", spot" : ""}, ${rec.maxHours} h limit${job}`);
    return rec;
  }

  /** A new cluster with the machine and limits of `id` (not started), owned by `owner`. */
  clone(id: string, owner?: string): ClusterRecord {
    const src = this.d.store.cluster(id);
    if (!src) throw new ClusterError("UnknownCluster", `unknown cluster ${id}`);
    const taken = this.d.store.read().clusters.map((c) => c.name);
    const copy = this.add({
      name: copyName(src.name, taken),
      instanceType: src.instanceType,
      autoTerminateMinutes: src.autoTerminateMinutes,
      volumeGb: src.volumeGb,
      libraries: src.libraries,
      env: src.env,
      initScript: src.initScript,
      spot: src.spot,
      maxHours: src.maxHours,
      tags: src.tags,
      owner,
    });
    this.log(copy.id, "cloned", `copy of ${src.name}`);
    return copy;
  }

  private add(input: NewCluster): ClusterRecord {
    const name = input.name.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/.test(name)) throw new ClusterError("InvalidCluster", "names are 1-40 letters, digits, spaces, _ . -");
    if (this.d.store.read().clusters.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      throw new ClusterError("InvalidCluster", `a cluster named ${name} already exists`);
    }
    const record: ClusterRecord = {
      id: `c-${this.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
      name,
      instanceType: checkedType(input.instanceType ?? DEFAULT_INSTANCE_TYPE),
      autoTerminateMinutes: checkedMinutes(input.autoTerminateMinutes ?? DEFAULT_AUTO_TERMINATE_MINUTES),
      volumeGb: checkedVolume(input.volumeGb ?? DEFAULT_VOLUME_GB),
      libraries: checkedLibraries(input.libraries ?? []),
      env: checkedEnv(input.env ?? {}),
      initScript: checkedInitScript(input.initScript ?? ""),
      spot: input.spot ?? false,
      maxHours: checkedMaxHours(input.maxHours ?? DEFAULT_MAX_HOURS),
      tags: checkedTags(input.tags ?? {}),
      createdAt: this.now(),
      runtime: { state: "terminated" },
      ...(input.job ? { job: input.job } : {}),
      ...(input.owner ? { owner: input.owner } : {}),
    };
    this.d.store.update((s) => void s.clusters.push(record));
    return record;
  }

  update(id: string, patch: Partial<ClusterPatch>): ClusterRecord {
    const before = this.d.store.cluster(id);
    const snapshot = before ? structuredClone(before) : undefined;
    const rec = this.d.store.updateCluster(id, (c) => {
      const next = {
        instanceType: patch.instanceType ? checkedType(patch.instanceType) : c.instanceType,
        volumeGb: patch.volumeGb ? checkedVolume(patch.volumeGb) : c.volumeGb,
        spot: patch.spot ?? c.spot,
        initScript: patch.initScript !== undefined ? checkedInitScript(patch.initScript) : c.initScript,
        tags: patch.tags !== undefined ? checkedTags(patch.tags) : c.tags,
      };
      const machineChange = MACHINE_FIELDS.some((f) => JSON.stringify(next[f]) !== JSON.stringify(c[f]));
      if (machineChange && c.runtime.state !== "terminated" && c.runtime.state !== "error") {
        throw new ClusterError("ClusterRunning", "terminate the cluster before changing its machine, spot, init script or tags");
      }
      if (patch.name !== undefined) c.name = patch.name.trim() || c.name;
      Object.assign(c, next);
      if (patch.libraries !== undefined) c.libraries = checkedLibraries(patch.libraries);
      if (patch.env !== undefined) c.env = checkedEnv(patch.env);
      if (patch.maxHours !== undefined) c.maxHours = checkedMaxHours(patch.maxHours);
      if (patch.autoTerminateMinutes !== undefined) c.autoTerminateMinutes = checkedMinutes(patch.autoTerminateMinutes);
      if (c.runtime.libraries) {
        for (const spec of Object.keys(c.runtime.libraries)) if (!c.libraries.includes(spec)) delete c.runtime.libraries[spec];
      }
    });
    if (snapshot) this.afterEdit(snapshot, rec);
    const changed = snapshot ? changes(snapshot, rec) : [];
    if (changed.length) this.log(id, "edited", changed.join(", "));
    return rec;
  }

  /** Edits that reach a running machine: new libraries are installed, a new time limit is set. */
  private afterEdit(before: ClusterRecord, after: ClusterRecord): void {
    if (after.runtime.state !== "running") return;
    const added = after.libraries.filter((l) => !before.libraries.includes(l));
    if (added.length) this.installLibraries(after.id, added);
    if (after.maxHours !== before.maxHours) this.setShutdown(after);
  }

  /** Best effort: the machine's own hard limit follows the new time limit. */
  private setShutdown(c: ClusterRecord): void {
    const left = (c.runtime.startedAt ?? this.now()) + c.maxHours * 3_600_000 - this.now();
    const minutes = Math.max(1, Math.ceil(left / 60_000));
    void Promise.resolve()
      .then(() => this.d.exec(this.endpoint(c.id), `sudo shutdown -c; sudo shutdown -h +${minutes} "iara: time limit"`, LOG_TIMEOUT_MS))
      .catch((e: Error) => console.error(`[clusters] time limit of ${c.id}: ${e.message}`));
  }

  /** Install libraries on the running machine in the background (one install at a time per cluster). */
  private installLibraries(id: string, specs: string[]): void {
    this.setLibraries(id, specs, { state: "installing" });
    this.log(id, "libraries", `installing ${specs.join(", ")}`);
    const run = async (): Promise<void> => {
      // as the kernel user, who owns the venv
      const command = `sudo -n -u ${KERNEL_USER} -H env -C ${KERNEL_HOME} ${UV} pip install -q --python ${VENV}/bin/python ${specs.map((s) => `'${s}'`).join(" ")} 2>&1`;
      let error: string | null = null;
      try {
        const r = await this.d.exec(this.endpoint(id), command, INSTALL_TIMEOUT_MS);
        if (r.code !== 0) error = tail(r.stdout, 10) || `the install exited with code ${r.code}`;
      } catch (e) {
        error = (e as Error).message;
      }
      this.setLibraries(id, specs, error === null ? { state: "installed" } : { state: "failed", error });
      this.log(id, "libraries", error === null ? `installed ${specs.join(", ")}` : `install failed: ${error}`);
    };
    const queued = (this.installs.get(id) ?? Promise.resolve()).then(run).catch((e: Error) => console.error(`[clusters] install on ${id}: ${e.message}`));
    const tracked: Promise<void> = queued.finally(() => {
      if (this.installs.get(id) === tracked) this.installs.delete(id);
    });
    this.installs.set(id, tracked);
  }

  /** Set the install state of `specs` that are still configured (the cluster may be gone). */
  private setLibraries(id: string, specs: string[], status: LibraryStatus): void {
    try {
      this.d.store.updateCluster(id, (c) => {
        const libraries = { ...c.runtime.libraries };
        for (const spec of specs) if (c.libraries.includes(spec)) libraries[spec] = status;
        c.runtime.libraries = libraries;
      });
    } catch {
      // the cluster was deleted meanwhile
    }
  }

  remove(id: string): void {
    const c = this.d.store.cluster(id);
    if (!c) return;
    if (c.runtime.state !== "terminated" && c.runtime.state !== "error") {
      throw new ClusterError("ClusterRunning", "terminate the cluster before deleting it");
    }
    this.d.store.update((s) => {
      s.clusters = s.clusters.filter((x) => x.id !== id);
      for (const [nb, cid] of Object.entries(s.attachments)) if (cid === id) delete s.attachments[nb];
      if (s.defaultCluster === id) delete s.defaultCluster;
    });
    this.d.events.forget(id);
  }

  /** The cluster's event log, newest first. */
  eventsOf(id: string): ClusterEvent[] {
    return this.d.events.list(id);
  }

  private log(id: string, kind: ClusterEventKind, message: string): void {
    try {
      this.d.events.record(id, { at: this.now(), kind, message });
    } catch (e) {
      console.error(`[clusters] event log of ${id}: ${(e as Error).message}`); // logging never fails a lifecycle step
    }
  }

  // -- lifecycle ---------------------------------------------------------------

  private cloud(): CloudApi {
    const cloud = this.d.cloud();
    if (!cloud) throw new ClusterError("NoCloud", "AWS is not configured for this Studio (set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)");
    return cloud;
  }

  private phase(id: string, phase: string): void {
    this.d.store.updateCluster(id, (c) => void (c.runtime.phase = phase));
  }

  /** Launch the cluster's machine; returns once the launch began (it takes minutes to finish). */
  start(id: string): ClusterRecord {
    const c = this.d.store.cluster(id);
    if (!c) throw new ClusterError("UnknownCluster", `unknown cluster ${id}`);
    if (c.runtime.state === "running" || c.runtime.state === "starting") return c;
    if (c.runtime.state === "terminating") throw new ClusterError("ClusterBusy", "the cluster is still terminating");
    this.cloud();
    const rec = this.d.store.updateCluster(id, (x) => void (x.runtime = { state: "starting", phase: "preparing" }));
    this.log(id, "start", "start requested");
    this.track(id, this.launch(id));
    return rec;
  }

  private track(id: string, job: Promise<void>): void {
    const tracked = job
      .catch((e: Error) => {
        this.d.store.updateCluster(id, (c) => void (c.runtime = { ...c.runtime, state: "error", error: e.message, phase: undefined }));
        this.log(id, "error", e.message);
        const instance = this.d.store.cluster(id)?.runtime.instanceId;
        if (instance) void this.d.cloud()?.terminate(instance).catch(() => {});
      })
      .finally(() => this.jobs.delete(id));
    this.jobs.set(id, tracked);
  }

  /** Wait for the cluster's current start or stop (tests, shutdown). */
  async settled(id: string): Promise<void> {
    await this.jobs.get(id);
    await this.installs.get(id);
  }

  private async launch(id: string): Promise<void> {
    const cloud = this.cloud();
    const c = this.d.store.cluster(id)!;
    const wheel = await cloud.engineWheel(this.d.engineVersion);
    if (!wheel) {
      throw new ClusterError("NoEngine", `the engine ${this.d.engineVersion} is not published for clusters: run \`python -m iara.cloud publish\``);
    }
    this.phase(id, "preparing network and access");
    const group = await cloud.teamNetwork(await cloud.studioCidrs());
    const profile = await cloud.instanceProfile();
    this.phase(id, "launching a machine");
    const team = this.d.teamBucket();
    const script = userData({
      authorizedKey: this.d.store.identity().publicKey,
      wheelUrl: wheel,
      proxy: team && { url: proxyUrlOf(wheel), endpoint: team.endpoint, bucket: team.bucket, region: team.region },
      idleMinutes: c.autoTerminateMinutes + WATCHDOG_GRACE_MINUTES,
      maxMinutes: c.maxHours * 60,
      region: cloud.region,
      libraries: c.libraries,
      initScript: c.initScript,
      env: c.env,
    });
    const { instanceId, spot } = await cloud.launch({
      clusterId: id,
      clusterName: c.name,
      instanceType: c.instanceType,
      volumeGb: c.volumeGb,
      userData: script,
      securityGroupId: group,
      instanceProfile: profile,
      spot: c.spot,
      tags: c.tags,
    });
    this.d.store.updateCluster(id, (x) => void (x.runtime = { ...x.runtime, instanceId, spot, startedAt: this.now(), phase: "booting" }));
    if (c.spot && !spot) this.log(id, "spot", "no spot capacity: started an on-demand machine");
    await this.waitReady(id, instanceId);
  }

  private async waitReady(id: string, instanceId: string): Promise<void> {
    const cloud = this.cloud();
    const deadline = this.now() + (this.d.bootTimeoutMs ?? 10 * 60_000);
    for (;;) {
      if (this.now() > deadline) throw new ClusterError("BootTimeout", "the machine did not become ready in time");
      const status = (await cloud.describe([instanceId]))[instanceId];
      // a machine EC2 does not list yet was just launched: wait for it (the deadline still applies)
      const gone = status.state === "shutting-down" || (status.state === "terminated" && status.reason !== NOT_FOUND);
      if (gone) throw new ClusterError("BootFailed", "the machine stopped while starting");
      if (status.state === "running" && status.publicIp) {
        this.d.store.updateCluster(id, (x) => void (x.runtime.publicIp = status.publicIp));
        if (await this.engineReady(id)) break;
        this.phase(id, "installing the engine");
      }
      await this.sleep(5000);
    }
    this.d.store.updateCluster(id, (x) => {
      // the boot script installed the configured libraries
      const libraries = Object.fromEntries(x.libraries.map((l) => [l, { state: "installed" } as LibraryStatus]));
      x.runtime = { ...x.runtime, state: "running", phase: undefined, lastActivity: this.now(), libraries };
    });
    this.log(id, "running", `machine ${instanceId} running at ${this.d.store.cluster(id)?.runtime.publicIp ?? "no address"}`);
  }

  /** Whether the boot script finished; throws `BootFailed` when it wrote a failure (with the log lines saved). */
  private async engineReady(id: string): Promise<boolean> {
    let out: string;
    try {
      const r = await this.d.exec(
        this.endpoint(id, true),
        `if test -f ${FAILED_MARKER}; then echo "failed:$(cat ${FAILED_MARKER})"; elif test -f ${READY_MARKER}; then echo ready; fi`,
        15_000,
      );
      if (r.code !== 0) return false;
      out = r.stdout;
    } catch {
      return false; // sshd not up yet
    }
    const failed = /^failed:(.*)$/m.exec(out);
    if (failed) {
      const message = failed[1].trim() || "the boot script failed";
      await this.saveBootLog(id, message);
      throw new ClusterError("BootFailed", message);
    }
    return out.includes("ready");
  }

  /** Keep the last lines of the log that explains a failed boot (the machine goes away). */
  private async saveBootLog(id: string, message: string): Promise<void> {
    const file = message.includes("init script") ? INIT_LOG : BOOT_LOG;
    try {
      const r = await this.d.exec(this.endpoint(id, true), `sudo tail -n 80 ${file}`, LOG_TIMEOUT_MS);
      const lines = splitLines(r.stdout);
      this.d.store.updateCluster(id, (x) => void (x.runtime.lastBootLog = lines));
    } catch {
      // no log is better than none of the error
    }
  }

  /** The last lines of a machine log: `boot` (engine and libraries) or `init` (the init script), over SSH. */
  async logs(id: string, source: "boot" | "init"): Promise<MachineLog> {
    if (id === LOCAL_CLUSTER) return { lines: [], unavailable: "the local cluster has no machine logs" };
    const c = this.d.store.cluster(id);
    if (!c) throw new ClusterError("UnknownCluster", `unknown cluster ${id}`);
    if (source === "init" && c.initScript === "") return { lines: [], unavailable: "this cluster has no init script" };
    const reachable = (c.runtime.state === "running" || c.runtime.state === "starting") && c.runtime.publicIp;
    const gone = (reason: string): MachineLog =>
      c.runtime.lastBootLog ? { lines: c.runtime.lastBootLog, unavailable: "the machine is gone: lines from its last failed start" } : { lines: [], unavailable: reason };
    if (!reachable) return gone(c.runtime.state === "starting" ? "the machine is not reachable yet" : "the cluster is terminated");
    const command = source === "boot" ? `sudo tail -n 500 ${BOOT_LOG}` : `sudo tail -n 500 ${INIT_LOG} 2>/dev/null`;
    try {
      const r = await this.d.exec(this.endpoint(id, true), command, LOG_TIMEOUT_MS);
      if (r.code === 0) return { lines: splitLines(r.stdout) };
      if (source === "init") return { lines: [], unavailable: "the init script has not run yet" };
    } catch {
      // handled below
    }
    return gone("the machine is not reachable yet");
  }

  /** How to reach a cluster's machine (the host key is learned on first contact). */
  endpoint(id: string, starting = false): SshEndpointLike {
    const c = this.d.store.cluster(id);
    if (!c || !c.runtime.publicIp || (!starting && c.runtime.state !== "running")) {
      throw new ClusterError("ClusterNotRunning", `cluster ${c?.name ?? id} is ${c?.runtime.state ?? "unknown"}: start it to run code`);
    }
    return {
      host: c.runtime.publicIp,
      username: SSH_USER,
      privateKey: this.d.store.identity().privateKey,
      hostKey: c.runtime.hostKey,
      onHostKey: (fp) => this.d.store.updateCluster(id, (x) => void (x.runtime.hostKey ??= fp)),
    };
  }

  /**
   * Terminate the cluster's machine (its configuration stays). `kind` says in
   * the event log why: a user's request, or the auto-termination for idleness.
   */
  async terminate(id: string, reason = USER_STOP, kind: "terminate" | "auto-terminate" = "terminate"): Promise<void> {
    const c = this.d.store.cluster(id);
    if (!c) return;
    if (c.runtime.state === "terminated") {
      this.dropJobClusters(); // a job run's cluster that never got a machine
      return;
    }
    this.terminateHook(id);
    const instance = c.runtime.instanceId;
    this.log(id, kind, kind === "auto-terminate" ? reason : reason === USER_STOP ? "terminate requested" : `terminate requested: ${reason}`);
    this.d.store.updateCluster(id, (x) => void (x.runtime = { ...x.runtime, state: "terminating", phase: reason }));
    if (!instance) {
      this.d.store.updateCluster(id, (x) => void (x.runtime = { state: "terminated", phase: reason, ...keptLog(x.runtime) }));
      this.log(id, "terminated", "no machine was running");
      this.dropJobClusters();
      return;
    }
    await this.cloud().terminate(instance);
  }

  /** Clusters made for job runs go away once their machines are gone. */
  private dropJobClusters(): void {
    for (const c of this.d.store.read().clusters) {
      if (c.job && (c.runtime.state === "terminated" || c.runtime.state === "error")) this.remove(c.id);
    }
  }

  /** Bring states in line with the machines (terminations finishing, machines that shut themselves down). */
  async reconcile(): Promise<void> {
    const cloud = this.d.cloud();
    if (!cloud) return;
    const live = this.d.store.read().clusters.filter((c) => c.runtime.instanceId && (c.runtime.state === "running" || c.runtime.state === "terminating"));
    if (!live.length) return;
    const status = await cloud.describe(live.map((c) => c.runtime.instanceId!));
    for (const c of live) {
      const s = status[c.runtime.instanceId!]?.state;
      if (s !== "terminated" && s !== "shutting-down" && s !== "stopped") continue;
      const reclaimed = c.runtime.spot && status[c.runtime.instanceId!]?.reason === "Server.SpotInstanceTermination";
      const why = c.runtime.state === "terminating" ? c.runtime.phase : reclaimed ? "AWS reclaimed the spot machine" : "the machine shut itself down";
      if (c.runtime.state === "running") this.terminateHook(c.id);
      if (s === "terminated" || c.runtime.state === "running") {
        this.d.store.updateCluster(c.id, (x) => void (x.runtime = { state: s === "terminated" ? "terminated" : "terminating", phase: why, ...keptLog(x.runtime) }));
      }
      if (s === "terminated") this.log(c.id, "terminated", `machine stopped: ${why}`);
    }
    this.dropJobClusters();
  }

  /** Resume starts interrupted by a Studio restart. */
  resume(): void {
    for (const c of this.d.store.read().clusters) {
      if (c.runtime.state !== "starting" || this.jobs.has(c.id)) continue;
      if (c.runtime.instanceId) this.track(c.id, this.waitReady(c.id, c.runtime.instanceId));
      else {
        const error = "the Studio restarted while starting the cluster";
        this.d.store.updateCluster(c.id, (x) => void (x.runtime = { state: "error", error }));
        this.log(c.id, "error", error);
      }
    }
  }

  /** Terminate running clusters without kernel activity for their auto-terminate time. */
  async reap(): Promise<string[]> {
    const done: string[] = [];
    for (const c of this.d.store.read().clusters) {
      if (c.runtime.state !== "running") continue;
      if (c.runtime.startedAt !== undefined && this.now() - c.runtime.startedAt >= c.maxHours * 3_600_000) {
        await this.terminate(c.id, `time limit of ${c.maxHours} h`, "auto-terminate");
        done.push(c.id);
        continue;
      }
      const act = this.activitySource(c.id);
      const last = act.busy ? this.now() : Math.max(c.runtime.lastActivity ?? 0, act.lastUsed);
      if (last !== c.runtime.lastActivity) this.d.store.updateCluster(c.id, (x) => void (x.runtime.lastActivity = last));
      if (!act.busy && this.now() - last >= c.autoTerminateMinutes * 60_000) {
        await this.terminate(c.id, `idle for ${c.autoTerminateMinutes} min`, "auto-terminate");
        done.push(c.id);
      }
    }
    return done;
  }

  // -- views -------------------------------------------------------------------

  views(): ClusterView[] {
    const s = this.d.store.read();
    const byCluster = new Map<string, string[]>();
    const def = this.defaultCluster();
    for (const [nb, id] of Object.entries(s.attachments)) byCluster.set(id, [...(byCluster.get(id) ?? []), nb]);
    const out: ClusterView[] = [];
    if (this.d.localCompute) {
      out.push({ id: LOCAL_CLUSTER, name: "Local", kind: "local", state: "running", notebooks: byCluster.get(LOCAL_CLUSTER) ?? [], isDefault: def === LOCAL_CLUSTER, canManage: false });
    }
    for (const c of s.clusters) {
      out.push({
        id: c.id,
        name: c.name,
        kind: "ec2",
        state: c.runtime.state,
        phase: c.runtime.phase,
        error: c.runtime.error,
        instanceType: instanceType(c.instanceType),
        autoTerminateMinutes: c.autoTerminateMinutes,
        volumeGb: c.volumeGb,
        startedAt: c.runtime.startedAt,
        lastActivity: c.runtime.lastActivity,
        publicIp: c.runtime.publicIp,
        libraries: c.libraries,
        libraryStatus: c.runtime.libraries ?? {},
        env: c.env,
        initScript: c.initScript,
        spot: c.spot,
        ...(c.runtime.state === "running" || c.runtime.state === "starting" ? { runningSpot: c.runtime.spot ?? false } : {}),
        maxHours: c.maxHours,
        tags: c.tags,
        notebooks: byCluster.get(c.id) ?? [],
        isDefault: def === c.id,
        canManage: false,
        ...(c.owner ? { owner: c.owner } : {}),
        ...(c.job ? { job: c.job } : {}),
      });
    }
    return out;
  }
}

/** What an edit changed, as "name a → b" parts. */
function changes(before: ClusterRecord, after: ClusterRecord): string[] {
  const out: string[] = [];
  if (before.name !== after.name) out.push(`name ${before.name} → ${after.name}`);
  if (before.instanceType !== after.instanceType) out.push(`machine ${before.instanceType} → ${after.instanceType}`);
  if (before.volumeGb !== after.volumeGb) out.push(`disk ${before.volumeGb} → ${after.volumeGb} GB`);
  if (before.autoTerminateMinutes !== after.autoTerminateMinutes) out.push(`idle timeout ${before.autoTerminateMinutes} → ${after.autoTerminateMinutes} min`);
  const libs = diffList(before.libraries, after.libraries);
  if (libs) out.push(`libraries ${libs}`);
  if (JSON.stringify(before.env) !== JSON.stringify(after.env)) out.push("environment changed");
  if (before.initScript !== after.initScript) out.push("init script changed");
  if (before.spot !== after.spot) out.push(`spot ${after.spot ? "on" : "off"}`);
  if (before.maxHours !== after.maxHours) out.push(`time limit ${before.maxHours} → ${after.maxHours} h`);
  if (JSON.stringify(before.tags) !== JSON.stringify(after.tags)) out.push("tags changed");
  return out;
}

/** "+a +b −c" for the items that differ (empty when none). */
function diffList(before: string[], after: string[]): string {
  const added = after.filter((x) => !before.includes(x)).map((x) => `+${x}`);
  const removed = before.filter((x) => !after.includes(x)).map((x) => `−${x}`);
  return [...added, ...removed].join(" ");
}

/** The failed-start log survives the machine (until the next start). */
function keptLog(runtime: ClusterRuntime): Pick<ClusterRuntime, "lastBootLog"> {
  return runtime.lastBootLog ? { lastBootLog: runtime.lastBootLog } : {};
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The last `n` lines of `text`, joined. */
function tail(text: string, n: number): string {
  return splitLines(text.trim()).slice(-n).join("\n");
}

/** "<name> copy", then "<name> copy 2", ...: the first free name, shortened to fit. */
export function copyName(name: string, taken: string[]): string {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? " copy" : ` copy ${n}`;
    const candidate = `${name.slice(0, NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

function checkedType(name: string): string {
  if (!instanceType(name)) throw new ClusterError("InvalidCluster", `unsupported instance type ${name}`);
  return name;
}

function checkedMinutes(m: number): number {
  if (!Number.isFinite(m) || m < MIN_AUTO_TERMINATE_MINUTES || m > 24 * 60) {
    throw new ClusterError("InvalidCluster", `auto-terminate must be between ${MIN_AUTO_TERMINATE_MINUTES} and ${24 * 60} minutes`);
  }
  return Math.round(m);
}

function checkedVolume(gb: number): number {
  if (!Number.isFinite(gb) || gb < 20 || gb > 2000) throw new ClusterError("InvalidCluster", "the volume must be between 20 and 2000 GB");
  return Math.round(gb);
}
