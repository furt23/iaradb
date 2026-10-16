import { describe, expect, it } from "vitest";

import type { ClusterView } from "@/server/compute/types";

import { EMPTY_FILTER, filterClusters, owners, stateCounts } from "./clusterFilter";

function cluster(over: Partial<ClusterView> & { id: string; name: string }): ClusterView {
  return {
    kind: "ec2",
    state: "running",
    notebooks: [],
    isDefault: false,
    canManage: false,
    ...over,
  };
}

const clusters: ClusterView[] = [
  cluster({ id: "a", name: "Analytics", state: "running", owner: "ana@x.com", instanceType: { name: "m7i.large", vcpus: 2, memoryGib: 8, usdPerHour: 0.1, family: "general" } }),
  cluster({ id: "b", name: "etl-nightly", state: "starting", owner: "bob@x.com", job: "nightly" }),
  cluster({ id: "c", name: "Scratch", state: "terminated" }),
  cluster({ id: "d", name: "broken", state: "error", owner: "ana@x.com" }),
  cluster({ id: "e", name: "Shutdown", state: "terminating", owner: "bob@x.com" }),
];

const ids = (list: ClusterView[]) => list.map((c) => c.id);

describe("filterClusters", () => {
  it("keeps everything with the empty filter", () => {
    expect(ids(filterClusters(clusters, EMPTY_FILTER))).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("searches name, instance type and owner, case-insensitively", () => {
    expect(ids(filterClusters(clusters, { ...EMPTY_FILTER, query: "ANALY" }))).toEqual(["a"]);
    expect(ids(filterClusters(clusters, { ...EMPTY_FILTER, query: "m7i" }))).toEqual(["a"]);
    expect(ids(filterClusters(clusters, { ...EMPTY_FILTER, query: "  bob@" }))).toEqual(["b", "e"]);
    expect(ids(filterClusters(clusters, { ...EMPTY_FILTER, query: "nothing" }))).toEqual([]);
  });

  it("splits running (starting, running, terminating) from stopped (terminated, error)", () => {
    expect(ids(filterClusters(clusters, { ...EMPTY_FILTER, state: "running" }))).toEqual(["a", "b", "e"]);
    expect(ids(filterClusters(clusters, { ...EMPTY_FILTER, state: "stopped" }))).toEqual(["c", "d"]);
  });

  it("matches the owner exactly", () => {
    expect(ids(filterClusters(clusters, { ...EMPTY_FILTER, owner: "ana@x.com" }))).toEqual(["a", "d"]);
    expect(ids(filterClusters(clusters, { ...EMPTY_FILTER, owner: "ana" }))).toEqual([]);
  });

  it("hides job clusters when jobs is false", () => {
    expect(ids(filterClusters(clusters, { ...EMPTY_FILTER, jobs: false }))).toEqual(["a", "c", "d", "e"]);
  });

  it("combines the parts", () => {
    expect(ids(filterClusters(clusters, { query: "", state: "running", owner: "bob@x.com", jobs: false }))).toEqual(["e"]);
  });
});

describe("stateCounts", () => {
  it("counts running, stopped and all", () => {
    expect(stateCounts(clusters)).toEqual({ all: 5, running: 3, stopped: 2 });
    expect(stateCounts([])).toEqual({ all: 0, running: 0, stopped: 0 });
  });
});

describe("owners", () => {
  it("lists the distinct owners, sorted", () => {
    expect(owners(clusters)).toEqual(["ana@x.com", "bob@x.com"]);
    expect(owners([cluster({ id: "z", name: "z" })])).toEqual([]);
  });
});
