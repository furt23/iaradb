import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DashboardConfig } from "@/lib/dashboards/types";
import { JOB_CLUSTER } from "@/lib/jobs";

let workspace: string;
let data: string;
let refresh: typeof import("./refresh");
let store: typeof import("./store");
let publish: typeof import("./publish");

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "iara-ws-"));
  data = fs.mkdtempSync(path.join(os.tmpdir(), "iara-data-"));
  vi.stubEnv("IARA_WORKSPACE", workspace);
  vi.stubEnv("IARA_STUDIO_DATA", data);
  vi.resetModules();
  refresh = await import("./refresh");
  store = await import("./store");
  publish = await import("./publish");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(data, { recursive: true, force: true });
});

const config: DashboardConfig = { id: "abcd1234", title: "Sales", cluster: "c1", refresh_minutes: 10, schedule: { cron: "0 6 * * 1-5", enabled: true } };

describe("refreshJob", () => {
  it("is a one-task job on a new small cluster per run, under a name job files cannot take", () => {
    const job = refresh.refreshJob("sales", config, true);
    expect(job).toMatchObject({ id: "dashboard-abcd1234", schedule: "0 6 * * 1-5", cluster: JOB_CLUSTER, instanceType: "m7i-flex.large", enabled: true, notify: [], params: {} });
    expect(job.tasks.map((t) => t.target)).toEqual(["dashboards/sales"]);
    expect(refresh.dashboardSlug(job.tasks[0].target)).toBe("sales");
  });

  it("runs on the dashboard's cluster without AWS, and is off without a schedule", () => {
    expect(refresh.refreshJob("sales", config, false)).toMatchObject({ cluster: "c1", instanceType: null });
    expect(refresh.refreshJob("sales", { ...config, cluster: undefined, schedule: undefined }, false)).toMatchObject({ cluster: "local", schedule: null, enabled: false });
  });

  it("knows a refresh task from a file", () => {
    expect(refresh.dashboardSlug("notebooks/sales.py")).toBeNull();
    expect(refresh.dashboardSlug("dashboards/sales/datasets/x.sql")).toBeNull();
  });
});

describe("refreshJobs", () => {
  it("lists the published dashboards that have a schedule", async () => {
    const scheduled = await store.createDashboard("Sales");
    const unscheduled = await store.createDashboard("Costs");
    const draft = await store.createDashboard("Draft");
    await store.saveConfig(scheduled.slug, { ...scheduled.config, schedule: { cron: "0 6 * * *", enabled: false } });
    await store.saveConfig(draft.slug, { ...draft.config, schedule: { cron: "0 6 * * *", enabled: true } });
    for (const d of [scheduled, unscheduled]) publish.publishDashboard(await store.readDashboard(d.slug), { kind: "team" }, "me");

    const jobs = await refresh.refreshJobs();
    expect(jobs.map((j) => [j.id, j.enabled])).toEqual([[`dashboard-${scheduled.config.id}`, false]]);
  });
});
