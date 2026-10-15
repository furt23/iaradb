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
  roleBuckets: string[] = [];
  async artifactsBucket() {
    return "artifacts";
  }
  async engineWheel(version: string) {
    return this.published ? `s3://artifacts/engine/${version}/iara.whl` : null;
  }
  async ensureNetwork() {
    return "sg-1";
  }
  async ensureRole(buckets: string[]) {
    this.roleBuckets = buckets;
    return "iara-cluster";
  }
  async launch(spec: LaunchSpec) {
    this.launched.push(spec);
    const id = `i-${this.launched.length}`;
    this.instances[id] = { state: "pending" };
    return id;
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

function setup(opts: { local?: boolean } = {}) {
  let now = 1_000_000;
  const store = new MemoryStore();
  const cloud = new FakeCloud();
  let ready = false;
  const activity = { lastUsed: 0, busy: false };
  const svc = new ClusterService({
    store,
    cloud: () => cloud,
    exec: async (ep) => {
      ep.onHostKey?.("SHA256-host");
      return { code: ready ? 0 : 1, stdout: ready ? "ready\n" : "" };
    },
    engineVersion: "0.1.0",
    dataBuckets: async () => ["sales-data"],
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
  return { svc, store, cloud, stopped, activity, tick: (ms: number) => (now += ms), now: () => now };
}

describe("clusters", () => {
  it("start launches a machine with the engine and becomes running", async () => {
    const { svc, cloud, store } = setup();
    const c = svc.create({ name: "dev" });
    expect(svc.start(c.id).runtime.state).toBe("starting");
    await svc.settled(c.id);
    const rec = store.cluster(c.id)!;
    expect(rec.runtime).toMatchObject({ state: "running", instanceId: "i-1", publicIp: "198.51.100.9", hostKey: "SHA256-host" });
    expect(cloud.roleBuckets).toEqual(["sales-data"]);
    expect(cloud.launched[0]).toMatchObject({ instanceType: "m7i-flex.large", securityGroupId: "sg-1", volumeGb: 40 });
    expect(cloud.launched[0].userData).toContain("s3://artifacts/engine/0.1.0/iara.whl");
    // the machine's watchdog waits a little longer than the Studio's reaper
    expect(cloud.launched[0].userData).toContain(`-ge ${20 * 60} ]`);
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
      "m7i-flex.large, 40 GB, 15 min idle limit",
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

describe("copyName", () => {
  it("numbers copies when the name is taken, and fits the name limit", () => {
    expect(copyName("dev", ["dev"])).toBe("dev copy");
    expect(copyName("dev", ["dev copy"])).toBe("dev copy 2");
    expect(copyName("dev", ["dev copy", "dev copy 2"])).toBe("dev copy 3");
    expect(copyName("x".repeat(40), [])).toBe(`${"x".repeat(35)} copy`);
    expect(copyName("x".repeat(40), [`${"x".repeat(35)} copy`])).toBe(`${"x".repeat(33)} copy 2`);
  });
});
