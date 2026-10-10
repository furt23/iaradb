import { describe, expect, it } from "vitest";

import type { ClusterView } from "@/server/compute/types";

import { costSoFar, formatMinutes, formatUsd, minutesSince, terminatesIn } from "./clusterTime";

const MIN = 60_000;
const base: ClusterView = {
  id: "c1",
  name: "small",
  kind: "ec2",
  state: "running",
  instanceType: { name: "m7i.large", vcpus: 2, memoryGib: 8, usdPerHour: 0.1, family: "general" },
  autoTerminateMinutes: 15,
  startedAt: 0,
  lastActivity: 5 * MIN,
  notebooks: [],
  isDefault: false,
};

describe("clusterTime", () => {
  it("counts whole minutes", () => {
    expect(minutesSince(0, 90_000)).toBeNull(); // no time
    expect(minutesSince(1, 1 + 2.5 * MIN)).toBe(2);
    expect(formatMinutes(12)).toBe("12 min");
    expect(formatMinutes(125)).toBe("2 h 5 min");
  });

  it("knows when an idle cluster is terminated", () => {
    expect(terminatesIn(base, 12 * MIN)).toBe(8);
    expect(terminatesIn(base, 60 * MIN)).toBe(0);
    expect(terminatesIn({ ...base, state: "terminated" }, 12 * MIN)).toBeNull();
    expect(terminatesIn({ ...base, kind: "local" }, 12 * MIN)).toBeNull();
  });

  it("prices the running machine", () => {
    expect(costSoFar({ ...base, startedAt: 1 }, 1 + 90 * MIN)).toBeCloseTo(0.15);
    expect(costSoFar({ ...base, startedAt: 1, state: "terminated" }, 90 * MIN)).toBeNull();
    expect(formatUsd(0.153)).toBe("$0.15");
    expect(formatUsd(12.34)).toBe("$12.3");
  });
});
