import { describe, expect, it } from "vitest";

import type { CloudApi, InstanceStatus, LaunchSpec } from "./cloud/api";
import { ClusterService, copyName, type StoreApi } from "./clusters";
import { ClusterEventLog, type EventFiles } from "./events";
import type { StudioState } from "./store";
import type { ClusterRecord } from "./types";

function memoryFiles(): EventFiles {
  const files = new Map<string, string>();
  return {
    append: (file, text) => void files.set(file, (files.get(file) ?? "") + text),
    read: (file) => files.get(file) ?? null,
    write: (file, text) => void files.set(file, text),
    remove: (file) => void files.delete(file),
  };
}

class MemoryStore implements StoreApi {
  state: StudioState = { installationId: "test", clusters: [], attachments: {} };
  read() {
    return this.state;
  }
  update<T>(fn: (s: StudioState) => T): T {
    const next = structuredClone(this.state);
    const out = fn(next);
    this.state = next;
    return out;
  }
  cluster(id: string) {
    return this.state.clusters.find((c) => c.id === id);
  }
  updateCluster(id: string, fn: (c: ClusterRecord) => void) {
    return this.update((s) => {
      const c = s.clusters.find((x) => x.id === id)!;
      fn(c);
      return structuredClone(c);
    });
  }
  identity() {
    return { privateKey: "PRIVATE", publicKey: "ssh-ed25519 AAAAC3Nz studio" };
  }
}

class FakeCloud implements CloudApi {
  region = "us-east-1";
  instances: Record<string, InstanceStatus> = {};
  launched: LaunchSpec[] = [];
  published = true;
  noSpot = false;
  /** why the team's resources cannot be found (undefined: they exist) */
  notSetUp?: Error;
  async artifactsBucket() {
    return "artifacts";
  }
  async engineWheel(version: string) {
    return this.published ? `s3://artifacts/engine/${version}/iara.whl` : null;
  }
  async teamNetwork() {
    if (this.notSetUp) throw this.notSetUp;
    return "sg-1";
  }
  async instanceProfile() {
    return "iara-cluster-acme";
  }
  async launch(spec: LaunchSpec) {
    this.launched.push(spec);
    const id = `i-${this.launched.length}`;
    this.instances[id] = { state: "pending" };
    return { instanceId: id, spot: spec.spot && !this.noSpot };
  }
  async describe(ids: string[]) {
    return Object.fromEntries(ids.map((id) => [id, this.instances[id] ?? { state: "terminated" }]));
  }
  async terminate(id: string) {
    this.instances[id] = { state: "shutting-down" };
  }
  async studioCidrs() {
    return ["203.0.113.7/32"];
  }
}

function setup(opts: { local?: boolean; team?: { bucket: string; endpoint: string; region: string } } = {}) {
  let now = 1_000_000;
  const store = new MemoryStore();
  const cloud = new FakeCloud();
  let ready = false;
  const commands: string[] = [];
  const replies: { match: RegExp; code?: number; stdout: string }[] = [];
  const activity = { lastUsed: 0, busy: false };
  const svc = new ClusterService({
    store,
    cloud: () => cloud,
    exec: async (ep, command) => {
      ep.onHostKey?.("SHA256-host");
      commands.push(command);
      const reply = replies.find((r) => r.match.test(command));
      if (reply) return { code: reply.code ?? 0, stdout: reply.stdout };
      return { code: ready ? 0 : 1, stdout: ready ? "ready\n" : "" };
    },
    engineVersion: "0.1.0",
    teamBucket: () => opts.team ?? null,
    localCompute: opts.local ?? true,
    events: new ClusterEventLog({ dir: "events", files: memoryFiles() }),
    now: () => now,
    // each wait moves the clock and lets the machine progress
    sleep: async (ms) => {
      now += ms;
      for (const [id, s] of Object.entries(cloud.instances)) if (s.state === "pending") cloud.instances[id] = { state: "running", publicIp: "198.51.100.9" };
      ready = true;
    },
  });
  const stopped: string[] = [];
  svc.onTerminate((id) => stopped.push(id));
  svc.activityFrom(() => activity);
  return { svc, store, cloud, commands, replies, stopped, activity, tick: (ms: number) => (now += ms), now: () => now };
}

describe("clusters", () => {
  it("start launches a machine with the engine and becomes running", async () => {
    const { svc, cloud, store } = setup();
    const c = svc.create({ name: "dev" });
    expect(svc.start(c.id).runtime.state).toBe("starting");
    await svc.settled(c.id);
    const rec = store.cluster(c.id)!;
    expect(rec.runtime).toMatchObject({ state: "running", instanceId: "i-1", publicIp: "198.51.100.9", hostKey: "SHA256-host" });
    expect(cloud.launched[0]).toMatchObject({ instanceType: "m7i-flex.large", securityGroupId: "sg-1", instanceProfile: "iara-cluster-acme", volumeGb: 40, spot: false, tags: {} });
    expect(cloud.launched[0].userData).toContain("s3://artifacts/engine/0.1.0/iara.whl");
    // the machine's watchdog waits a little longer than the Studio's reaper
    expect(cloud.launched[0].userData).toContain(`-ge ${20 * 60} ]`);
  });

  it("installs the team bucket's proxy on the machine when the Studio has a bucket, without keys", async () => {
    const team = { bucket: "team-data", endpoint: "https://acc.r2.cloudflarestorage.com", region: "auto" };
    const { svc, cloud } = setup({ team });
    const c = svc.create({ name: "dev" });
    svc.start(c.id);
    await svc.settled(c.id);
    const script = cloud.launched[0].userData;
    expect(script).toContain("'s3://artifacts/engine/0.1.0/iara-s3-proxy-x86_64' /usr/local/bin/iara-s3-proxy");
    expect(script).toContain("--endpoint https://acc.r2.cloudflarestorage.com --bucket team-data --region auto --keys-file /etc/iara/r2.json");
    expect(script).toContain("User=iara-proxy");
  });

  it("installs no proxy without a team bucket", async () => {
    const { svc, cloud } = setup();
    const c = svc.create({ name: "dev" });
    svc.start(c.id);
    await svc.settled(c.id);
    expect(cloud.launched[0].userData).not.toContain("iara-s3-proxy");
  });

  it("refuses to start without a published engine, and terminates nothing", async () => {
    const { svc, cloud, store } = setup();
    cloud.published = false;
    const c = svc.create({ name: "dev" });
    svc.start(c.id);
    await svc.settled(c.id);
    expect(store.cluster(c.id)!.runtime).toMatchObject({ state: "error" });
    expect(store.cluster(c.id)!.runtime.error).toMatch(/iara.cloud publish/);
    expect(cloud.launched).toHaveLength(0);
  });

  it("fails a start clearly when the team's AWS setup is missing, and launches nothing", async () => {
    const { svc, cloud, store } = setup();
    cloud.notSetUp = new Error("AWS is not set up for team acme: run `python -m iara.cloud team-setup acme` with admin credentials");
    const c = svc.create({ name: "dev" });
    svc.start(c.id);
    await svc.settled(c.id);
    expect(store.cluster(c.id)!.runtime).toMatchObject({ state: "error" });
    expect(store.cluster(c.id)!.runtime.error).toMatch(/team-setup acme/);
    expect(cloud.launched).toHaveLength(0);
  });

  it("terminates idle clusters, keeps busy ones, and stops their kernels", async () => {
    const { svc, store, cloud, stopped, activity, tick, now } = setup();
    const c = svc.create({ name: "dev", autoTerminateMinutes: 15 });
    svc.start(c.id);
    await svc.settled(c.id);
    tick(10 * 60_000);
    activity.lastUsed = now();
    expect(await svc.reap()).toEqual([]);
    tick(14 * 60_000);
    activity.busy = true;
    expect(await svc.reap()).toEqual([]);
    activity.busy = false;
    tick(16 * 60_000);
    expect(await svc.reap()).toEqual([c.id]);
    expect(stopped).toEqual([c.id]);
    expect(store.cluster(c.id)!.runtime.state).toBe("terminating");
    cloud.instances["i-1"] = { state: "terminated" };
    await svc.reconcile();
    expect(store.cluster(c.id)!.runtime).toEqual({ state: "terminated", phase: "idle for 15 min" });
  });

  it("notices machines that shut themselves down", async () => {
    const { svc, store, cloud, stopped } = setup();
    const c = svc.create({ name: "dev" });
    svc.start(c.id);
    await svc.settled(c.id);
    cloud.instances["i-1"] = { state: "terminated" };
    await svc.reconcile();
    expect(store.cluster(c.id)!.runtime.state).toBe("terminated");
    expect(stopped).toEqual([c.id]);
  });

  it("clusters made for job runs are never the default and go away with their machines", async () => {
    const { svc, store, cloud } = setup({ local: false });
    const run = svc.create({ name: "job-r-1", job: "r-1" });
    expect(svc.defaultCluster()).toBeNull();
    const shared = svc.create({ name: "shared" });
    expect(svc.defaultCluster()).toBe(shared.id);
    expect(svc.views().find((v) => v.id === run.id)?.job).toBe("r-1");
    svc.start(run.id);
    await svc.settled(run.id);
    await svc.terminate(run.id, "job run finished");
    cloud.instances["i-1"] = { state: "terminated" };
    await svc.reconcile();
    expect(store.cluster(run.id)).toBeUndefined();
    // one that never got a machine goes at once
    const early = svc.create({ name: "job-r-2", job: "r-2" });
    await svc.terminate(early.id);
    expect(store.cluster(early.id)).toBeUndefined();
    expect(store.cluster(shared.id)).toBeDefined();
  });

  it("attaches notebooks, falls back to the default and forgets deleted clusters", () => {
    const { svc } = setup();
    const a = svc.create({ name: "a" });
    expect(svc.clusterOf("nb/x.py")).toBe("local");
    svc.attach("nb/x.py", a.id);
    svc.attach("nb/y.py", a.id);
    expect(svc.clusterOf("nb/x.py")).toBe(a.id);
    expect(svc.views().find((v) => v.id === a.id)?.notebooks).toEqual(["nb/x.py", "nb/y.py"]);
    svc.moved((p) => (p === "nb/x.py" ? "nb/z.py" : null));
    expect(svc.clusterOf("nb/z.py")).toBe(a.id);
    svc.remove(a.id);
    expect(svc.clusterOf("nb/z.py")).toBe("local");
  });

  it("without local compute the first cluster is the default", () => {
    const { svc } = setup({ local: false });
    expect(svc.defaultCluster()).toBeNull();
    const a = svc.create({ name: "a" });
    expect(svc.defaultCluster()).toBe(a.id);
    expect(svc.views().map((v) => v.id)).toEqual([a.id]);
  });

  it("validates configurations", () => {
    const { svc } = setup();
    expect(() => svc.create({ name: "x", instanceType: "t2.nano" })).toThrow(/unsupported/);
    expect(() => svc.create({ name: "x", autoTerminateMinutes: 1 })).toThrow(/between 5/);
    svc.create({ name: "x" });
    expect(() => svc.create({ name: "X" })).toThrow(/already exists/);
  });

  it("keeps an event log per cluster, newest first", async () => {
    const { svc, cloud } = setup();
    const c = svc.create({ name: "dev" });
    svc.update(c.id, { autoTerminateMinutes: 30 });
    svc.start(c.id);
    await svc.settled(c.id);
    await svc.terminate(c.id);
    cloud.instances["i-1"] = { state: "terminated" };
    await svc.reconcile();
    const log = svc.eventsOf(c.id);
    expect(log.map((e) => e.kind)).toEqual(["terminated", "terminate", "running", "start", "edited", "created"]);
    expect(log.map((e) => e.message)).toEqual([
      "machine stopped: stopped by the user",
      "terminate requested",
      "machine i-1 running at 198.51.100.9",
      "start requested",
      "idle timeout 15 → 30 min",
      "m7i-flex.large, 40 GB, 15 min idle limit, 1 h limit",
    ]);
  });

  it("logs the idle minutes when a cluster is auto-terminated", async () => {
    const { svc, tick, now, activity } = setup();
    const c = svc.create({ name: "dev", autoTerminateMinutes: 15 });
    svc.start(c.id);
    await svc.settled(c.id);
    activity.lastUsed = now();
    tick(16 * 60_000);
    expect(await svc.reap()).toEqual([c.id]);
    expect(svc.eventsOf(c.id)[0]).toMatchObject({ kind: "auto-terminate", message: "idle for 15 min" });
  });

  it("logs the error that stopped a start", async () => {
    const { svc, cloud } = setup();
    cloud.published = false;
    const c = svc.create({ name: "dev" });
    svc.start(c.id);
    await svc.settled(c.id);
    expect(svc.eventsOf(c.id).slice(0, 2).map((e) => e.kind)).toEqual(["error", "start"]);
    expect(svc.eventsOf(c.id)[0].message).toMatch(/iara.cloud publish/);
  });

  it("clones a cluster's machine and limits, without starting it", () => {
    const { svc, store } = setup({ local: false });
    const a = svc.create({ name: "dev", instanceType: "r7i.xlarge", autoTerminateMinutes: 30, volumeGb: 100 });
    const copy = svc.clone(a.id);
    expect(copy).toMatchObject({ name: "dev copy", instanceType: "r7i.xlarge", autoTerminateMinutes: 30, volumeGb: 100 });
    expect(copy).toMatchObject({ libraries: [], spot: false, maxHours: 1 });
    expect(copy.runtime.state).toBe("terminated");
    expect(svc.eventsOf(copy.id).map((e) => e.kind)).toEqual(["cloned"]);
    expect(store.read().clusters).toHaveLength(2);
    expect(() => svc.clone("nope")).toThrow(/unknown cluster/);
  });

  it("records the owner on create and clone, and shows it in the views", () => {
    const { svc, store } = setup({ local: false });
    const a = svc.create({ name: "dev", owner: "alice@x.com" });
    const copy = svc.clone(a.id, "bob@x.com");
    const legacy = svc.create({ name: "old" });
    expect(store.cluster(a.id)?.owner).toBe("alice@x.com");
    expect(store.cluster(copy.id)?.owner).toBe("bob@x.com");
    expect("owner" in legacy).toBe(false);
    const views = svc.views();
    expect(views.find((v) => v.id === a.id)).toMatchObject({ owner: "alice@x.com", canManage: false });
    expect(views.find((v) => v.id === legacy.id)?.owner).toBeUndefined();
  });

  it("logs notebooks moving between clusters, and detaching them", () => {
    const { svc } = setup();
    const a = svc.create({ name: "a" });
    const b = svc.create({ name: "b" });
    svc.attach("nb/x.py", a.id);
    svc.attach("nb/x.py", b.id);
    expect(svc.eventsOf(a.id).map((e) => e.kind)).toEqual(["detached", "attached", "created"]);
    expect(svc.eventsOf(b.id)[0]).toMatchObject({ kind: "attached", message: "nb/x.py attached" });
    svc.detach("nb/x.py");
    expect(svc.clusterOf("nb/x.py")).toBe("local");
    expect(svc.eventsOf(b.id).map((e) => e.kind)).toEqual(["detached", "attached", "created"]);
    svc.detach("nb/x.py"); // nothing attached any more: no event
    expect(svc.eventsOf(b.id)).toHaveLength(3);
  });
});

describe("cluster settings", () => {
  it("stores and clones the new settings, and shows them in the views", () => {
    const { svc } = setup({ local: false });
    const a = svc.create({ name: "a", libraries: ["polars==1.9"], env: { A: "1" }, initScript: "echo hi", spot: true, maxHours: 3, tags: { team: "x" } });
    expect(svc.eventsOf(a.id)[0].message).toBe("m7i-flex.large, 40 GB, 15 min idle limit, spot, 3 h limit");
    const copy = svc.clone(a.id);
    expect(copy).toMatchObject({ libraries: ["polars==1.9"], env: { A: "1" }, initScript: "echo hi", spot: true, maxHours: 3, tags: { team: "x" } });
    expect(svc.views().find((v) => v.id === a.id)).toMatchObject({ libraries: ["polars==1.9"], libraryStatus: {}, spot: true, maxHours: 3 });
    expect(() => svc.create({ name: "b", maxHours: 13 })).toThrow(/between 1 and 12/);
  });

  it("machine fields change only while terminated; the rest any time", async () => {
    const { svc } = setup();
    const c = svc.create({ name: "dev" });
    svc.update(c.id, { spot: true, initScript: "ls", tags: { a: "b" } });
    svc.start(c.id);
    await svc.settled(c.id);
    for (const patch of [{ spot: false }, { initScript: "" }, { tags: {} }, { volumeGb: 100 }]) {
      expect(() => svc.update(c.id, patch)).toThrow(/terminate the cluster before changing its machine, spot, init script or tags/);
    }
    svc.update(c.id, { name: "dev2", env: { X: "1" }, maxHours: 2, autoTerminateMinutes: 30 });
    expect(svc.eventsOf(c.id)[0].message).toBe("name dev → dev2, idle timeout 15 → 30 min, environment changed, time limit 1 → 2 h");
  });

  it("installs added libraries on a running machine, and a failure does not break the cluster", async () => {
    const { svc, store, commands, replies } = setup();
    const c = svc.create({ name: "dev", libraries: ["a"] });
    svc.start(c.id);
    await svc.settled(c.id);
    expect(store.cluster(c.id)!.runtime.libraries).toEqual({ a: { state: "installed" } });
    svc.update(c.id, { libraries: ["a", "pandas[parquet]", "b>=1"] });
    expect(store.cluster(c.id)!.runtime.libraries).toMatchObject({ "pandas[parquet]": { state: "installing" } });
    await svc.settled(c.id);
    expect(commands.at(-1)).toContain(
      "sudo -n -u iara -H env -C /home/iara /home/iara/.local/bin/uv pip install -q --python /home/iara/venv/bin/python 'pandas[parquet]' 'b>=1'",
    );
    expect(store.cluster(c.id)!.runtime.libraries).toMatchObject({ a: { state: "installed" }, "b>=1": { state: "installed" } });
    replies.push({ match: /uv pip install/, code: 1, stdout: "no such package\n" });
    svc.update(c.id, { libraries: ["a", "nope"] });
    await svc.settled(c.id);
    const rt = store.cluster(c.id)!.runtime;
    expect(rt.state).toBe("running");
    expect(rt.libraries).toEqual({ a: { state: "installed" }, nope: { state: "failed", error: "no such package" } });
    expect(svc.eventsOf(c.id).filter((e) => e.kind === "libraries").map((e) => e.message)).toEqual([
      "install failed: no such package",
      "installing nope",
      "installed pandas[parquet], b>=1",
      "installing pandas[parquet], b>=1",
    ]);
  });

  it("terminates a cluster at its time limit, however busy", async () => {
    const { svc, tick, activity } = setup();
    const c = svc.create({ name: "dev", maxHours: 1 });
    svc.start(c.id);
    await svc.settled(c.id);
    activity.busy = true;
    tick(50 * 60_000);
    expect(await svc.reap()).toEqual([]);
    tick(11 * 60_000);
    expect(await svc.reap()).toEqual([c.id]);
    expect(svc.eventsOf(c.id)[0]).toMatchObject({ kind: "auto-terminate", message: "time limit of 1 h" });
  });

  it("moves the machine's own limit when the time limit changes", async () => {
    const { svc, commands, tick } = setup();
    const c = svc.create({ name: "dev" });
    svc.start(c.id);
    await svc.settled(c.id);
    tick(30 * 60_000);
    svc.update(c.id, { maxHours: 2 });
    await Promise.resolve();
    await Promise.resolve();
    expect(commands.some((x) => x.startsWith("sudo shutdown -c; sudo shutdown -h +90"))).toBe(true);
  });

  it("logs a spot request that fell back to on-demand, and a spot reclaim", async () => {
    const { svc, store, cloud } = setup();
    cloud.noSpot = true;
    const c = svc.create({ name: "dev", spot: true });
    svc.start(c.id);
    await svc.settled(c.id);
    expect(store.cluster(c.id)!.runtime.spot).toBe(false);
    expect(svc.eventsOf(c.id).find((e) => e.kind === "spot")?.message).toBe("no spot capacity: started an on-demand machine");
    expect(svc.views().find((v) => v.id === c.id)?.runningSpot).toBe(false);
    cloud.noSpot = false;
    await svc.terminate(c.id);
    cloud.instances["i-1"] = { state: "terminated" };
    await svc.reconcile();
    svc.start(c.id);
    await svc.settled(c.id);
    expect(store.cluster(c.id)!.runtime.spot).toBe(true);
    cloud.instances["i-2"] = { state: "terminated", reason: "Server.SpotInstanceTermination" };
    await svc.reconcile();
    expect(store.cluster(c.id)!.runtime.phase).toBe("AWS reclaimed the spot machine");
  });

  it("keeps the log of a failed boot and serves it when the machine is gone", async () => {
    const { svc, store, replies } = setup();
    replies.push(
      { match: /test -f/, stdout: "failed:the init script failed: see the Init script log\n" },
      { match: /tail -n 80 \/var\/log\/iara-init.log/, stdout: "line 1\nboom\n" },
    );
    const c = svc.create({ name: "dev", initScript: "exit 1" });
    svc.start(c.id);
    await svc.settled(c.id);
    const rt = store.cluster(c.id)!.runtime;
    expect(rt).toMatchObject({ state: "error", error: "the init script failed: see the Init script log", lastBootLog: ["line 1", "boom"] });
    expect(await svc.logs(c.id, "init")).toEqual({ lines: ["line 1", "boom"], unavailable: "the machine is gone: lines from its last failed start" });
    svc.start(c.id);
    expect(store.cluster(c.id)!.runtime.lastBootLog).toBeUndefined();
  });

  it("reads machine logs over SSH, with a reason when there are none", async () => {
    const { svc, replies } = setup({ local: false });
    const c = svc.create({ name: "dev", initScript: "echo" });
    const plain = svc.create({ name: "plain" });
    expect(await svc.logs("local", "boot")).toEqual({ lines: [], unavailable: "the local cluster has no machine logs" });
    expect(await svc.logs(plain.id, "init")).toEqual({ lines: [], unavailable: "this cluster has no init script" });
    expect(await svc.logs(c.id, "boot")).toEqual({ lines: [], unavailable: "the cluster is terminated" });
    svc.start(c.id);
    await svc.settled(c.id);
    replies.push({ match: /tail -n 500 \/var\/log\/cloud-init/, stdout: "a\nb\n" });
    expect(await svc.logs(c.id, "boot")).toEqual({ lines: ["a", "b"] });
  });
});

describe("copyName", () => {
  it("numbers copies when the name is taken, and fits the name limit", () => {
    expect(copyName("dev", ["dev"])).toBe("dev copy");
    expect(copyName("dev", ["dev copy"])).toBe("dev copy 2");
    expect(copyName("dev", ["dev copy", "dev copy 2"])).toBe("dev copy 3");
    expect(copyName("x".repeat(40), [])).toBe(`${"x".repeat(35)} copy`);
    expect(copyName("x".repeat(40), [`${"x".repeat(35)} copy`])).toBe(`${"x".repeat(33)} copy 2`);
  });
});
