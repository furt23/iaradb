import { describe, expect, it } from "vitest";

import type { ClusterView } from "@/server/compute/types";

import { canTerminate, groupClusters, notebooksLabel, runtimeSummary, showSearch } from "./clusterPicker";

const MIN = 60_000;

function cluster(name: string, patch: Partial<ClusterView> = {}): ClusterView {
  return { id: name, name, kind: "ec2", state: "running", notebooks: [], isDefault: false, ...patch };
}

describe("groupClusters", () => {
  it("splits running and stopped clusters and hides job clusters", () => {
    const list = [
      cluster("analytics", { state: "terminated" }),
      cluster("etl", { state: "starting" }),
      cluster("broken", { state: "error" }),
      cluster("nightly", { job: "run-1" }),
      cluster("Local", { kind: "local" }),
    ];
    const { running, stopped } = groupClusters(list);
    expect(running.map((c) => c.name)).toEqual(["etl", "Local"]);
    expect(stopped.map((c) => c.name)).toEqual(["analytics", "broken"]);
  });

  it("puts the default cluster first and keeps the others in order", () => {
    const list = [
      cluster("a"),
      cluster("b", { isDefault: true }),
      cluster("c", { state: "terminated" }),
      cluster("d", { state: "terminated", isDefault: true }),
    ];
    const { running, stopped } = groupClusters(list);
    expect(running.map((c) => c.name)).toEqual(["b", "a"]);
    expect(stopped.map((c) => c.name)).toEqual(["d", "c"]);
  });

  it("filters by name, ignoring case and surrounding spaces", () => {
    const list = [cluster("Analytics"), cluster("etl"), cluster("analyst-old", { state: "terminated" })];
    const { running, stopped } = groupClusters(list, "  ANA ");
    expect(running.map((c) => c.name)).toEqual(["Analytics"]);
    expect(stopped.map((c) => c.name)).toEqual(["analyst-old"]);
    expect(groupClusters(list, "zzz")).toEqual({ running: [], stopped: [] });
  });

  it("does not change its input", () => {
    const list = [cluster("b"), cluster("a", { isDefault: true })];
    groupClusters(list);
    expect(list.map((c) => c.name)).toEqual(["b", "a"]);
  });
});

describe("showSearch", () => {
  it("offers a search above six clusters", () => {
    const six = Array.from({ length: 6 }, (_, i) => cluster(`c${i}`));
    expect(showSearch(six)).toBe(false);
    expect(showSearch([...six, cluster("c6")])).toBe(true);
  });

  it("does not count job clusters", () => {
    const list = [...Array.from({ length: 6 }, (_, i) => cluster(`c${i}`)), cluster("job", { job: "run" })];
    expect(showSearch(list)).toBe(false);
  });
});

describe("canTerminate", () => {
  it("terminates only EC2 machines that are up or starting", () => {
    expect(canTerminate(cluster("a", { state: "running" }))).toBe(true);
    expect(canTerminate(cluster("a", { state: "starting" }))).toBe(true);
    expect(canTerminate(cluster("a", { state: "terminating" }))).toBe(false);
    expect(canTerminate(cluster("a", { state: "terminated" }))).toBe(false);
    expect(canTerminate(cluster("Local", { kind: "local" }))).toBe(false);
  });
});

describe("notebooksLabel", () => {
  it("pluralizes", () => {
    expect(notebooksLabel(0)).toBe("0 notebooks");
    expect(notebooksLabel(1)).toBe("1 notebook");
    expect(notebooksLabel(2)).toBe("2 notebooks");
  });
});

describe("runtimeSummary", () => {
  const started = 1_000_000;
  const machine = {
    startedAt: started,
    autoTerminateMinutes: 15,
    instanceType: { name: "m7i.large", vcpus: 2, memoryGib: 8, usdPerHour: 0.5, family: "general" },
  };

  it("sums up a running machine: uptime, idle time, auto-termination and cost", () => {
    const c = cluster("small", { ...machine, lastActivity: started + 62 * MIN });
    expect(runtimeSummary(c, started + 65 * MIN)).toBe("up 1 h 5 min · idle 3 min · terminates in 12 min if idle · ≈$0.54 so far");
  });

  it("says when an idle machine is about to be terminated", () => {
    const c = cluster("small", { ...machine, lastActivity: started });
    expect(runtimeSummary(c, started + 20 * MIN)).toContain("terminates soon if idle");
  });

  it("is only for running EC2 machines", () => {
    expect(runtimeSummary(cluster("small", { ...machine, state: "starting" }), started + 5 * MIN)).toBeNull();
    expect(runtimeSummary(cluster("Local", { kind: "local", startedAt: started }), started + 5 * MIN)).toBeNull();
  });
});
