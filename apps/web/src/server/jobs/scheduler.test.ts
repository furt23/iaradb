import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JobSpec } from "@/lib/jobs";

import { Scheduler } from "./scheduler";

const fake = vi.hoisted(() => ({
  jobs: [] as unknown[],
  refreshes: [] as unknown[],
  published: [] as unknown[],
  fired: {} as Record<string, number>,
  unchanged: vi.fn(),
  startRun: vi.fn(),
  recordSkippedRun: vi.fn(),
  setFiredAt: vi.fn(),
}));
vi.mock("./files", () => ({ listJobs: async () => ({ jobs: fake.jobs }) }));
vi.mock("../dashboards/refresh", () => ({ refreshJobs: async () => fake.refreshes, refreshJobId: (id: string) => `dashboard-${id}` }));
vi.mock("../dashboards/publish", () => ({ listPublished: () => fake.published }));
vi.mock("../dashboards/unchanged", () => ({ sourcesUnchanged: fake.unchanged }));
vi.mock("./runner", () => ({
  activeRun: () => undefined,
  settleInterrupted: () => {},
  startRun: fake.startRun,
  recordSkippedRun: fake.recordSkippedRun,
}));
vi.mock("./runs", () => ({ firedAt: () => fake.fired, setFiredAt: fake.setFiredAt }));

const now = new Date(2026, 10, 14, 12, 0, 30);
const minuteAgo = now.getTime() - 2 * 60_000;

function job(id: string): JobSpec {
  return {
    id,
    name: id,
    tasks: [],
    params: {},
    notify: [],
    schedule: "* * * * *",
    cluster: "local",
    instanceType: null,
    timeoutMinutes: 60,
    enabled: true,
  } as unknown as JobSpec;
}

const refresh = job("dashboard-abcd1234");
const published = { id: "abcd1234", datasets: [], widgets: [], title: "Sales" };

describe("Scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fake.jobs = [];
    fake.refreshes = [refresh];
    fake.published = [published];
    fake.fired = { [refresh.id]: minuteAgo };
  });

  it("records a skipped run and starts nothing for a due refresh whose sources are unchanged", async () => {
    fake.unchanged.mockResolvedValue(true);

    const started = await new Scheduler(() => now).tick();

    expect(fake.unchanged).toHaveBeenCalledWith(published);
    expect(fake.recordSkippedRun).toHaveBeenCalledWith(refresh, "No source changed since the last refresh");
    expect(fake.startRun).not.toHaveBeenCalled();
    expect(started).toEqual([]);
    expect(fake.setFiredAt).toHaveBeenCalledWith({ [refresh.id]: now.getTime() - 30_000 });
  });

  it("starts a due refresh whose sources changed", async () => {
    fake.unchanged.mockResolvedValue(false);

    const started = await new Scheduler(() => now).tick();

    expect(fake.recordSkippedRun).not.toHaveBeenCalled();
    expect(fake.startRun).toHaveBeenCalledWith(refresh, "schedule");
    expect(started).toEqual([refresh.id]);
  });

  it("starts a refresh whose dashboard is not found as published", async () => {
    fake.published = [];
    fake.unchanged.mockResolvedValue(true);

    await new Scheduler(() => now).tick();

    expect(fake.recordSkippedRun).not.toHaveBeenCalled();
    expect(fake.startRun).toHaveBeenCalledWith(refresh, "schedule");
  });

  it("starts a normal job without looking at the sources", async () => {
    const normal = job("nightly");
    fake.jobs = [normal];
    fake.refreshes = [];
    fake.fired = { nightly: minuteAgo };
    fake.unchanged.mockResolvedValue(true);

    const started = await new Scheduler(() => now).tick();

    expect(fake.unchanged).not.toHaveBeenCalled();
    expect(fake.recordSkippedRun).not.toHaveBeenCalled();
    expect(fake.startRun).toHaveBeenCalledWith(normal, "schedule");
    expect(started).toEqual(["nightly"]);
  });
});
