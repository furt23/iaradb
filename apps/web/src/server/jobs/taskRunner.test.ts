import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Dashboard, PublishedDashboard } from "@/lib/dashboards/types";
import { taskOf } from "@/lib/jobs";

import { publishDashboard } from "../dashboards/publish";
import { HIDDEN_ERROR } from "../dashboards/run";
import { readSnapshot } from "../dashboards/snapshots";
import type { TaskInput } from "./orchestrator";
import { refreshDashboard, runTask } from "./taskRunner";

const fake = vi.hoisted(() => ({ request: vi.fn(), endJob: vi.fn() }));
vi.mock("../kernel/manager", () => ({ kernels: { forJob: () => ({ request: fake.request }), endJob: fake.endJob } }));
vi.mock("../workspace/catalogChanges", () => ({ applyCatalogChanges: async () => {} }));
vi.mock("../dashboards/store", () => ({
  readConfig: async (slug: string) => {
    if (slug !== "sales") throw new Error(`there is no dashboard ${slug}`);
    return { id: "abcd1234", title: "Sales", refresh_minutes: 5 };
  },
}));

const columns = [{ name: "region", type: "string_view" }];
const dashboard: Dashboard = {
  slug: "sales",
  config: { id: "abcd1234", title: "Sales", refresh_minutes: 5 },
  datasets: [
    { name: "sales", sql: "SELECT * FROM sales", params: {} },
    { name: "costs", sql: "SELECT * FROM costs", params: {} },
  ],
  widgets: [
    { id: "chart001", kind: "chart", dataset: "sales", spec: { kind: "bar", x: "region", y: ["amount"], agg: "sum" } },
    { id: "table001", kind: "table", dataset: "costs" },
    { id: "text0001", kind: "text", markdown: "hi" },
  ],
  layout: [],
  problems: [],
};

/** `sql.run` answers a table, or an error for a query that reads `costs` when `costsFail` */
function kernel(costsFail = false) {
  let n = 0;
  fake.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "sql.run":
        if (costsFail && String(params.query).includes("costs")) return { type: "error", ename: "CatalogError", evalue: "table main.secret.costs does not exist" };
        return { type: "table", result: { id: `r${++n}`, columns, num_rows: 1 } };
      case "result.chart":
        return { columns: ["region", "amount"], rows: [["EU", 3]], truncated: false };
      case "result.page":
        return { offset: 0, total: 1, rows: [["EU"]] };
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
}

let logs: string[];
const input = (target = "dashboards/sales"): TaskInput => ({
  jobId: "nightly",
  runId: "run1",
  task: taskOf(target),
  attempt: 1,
  params: {},
  cluster: { id: "c1", name: "job" },
  signal: new AbortController().signal,
  log: (text) => void logs.push(text),
});
const publish = (share: PublishedDashboard["share"] = { kind: "team" }) => publishDashboard(dashboard, share, "admin@x.com");

let dataDir: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iara-refresh-"));
  vi.stubEnv("IARA_STUDIO_DATA", dataDir);
  // sign-in off unless a test turns it on
  vi.stubEnv("IARA_AUTH", "off");
  vi.stubEnv("AUTH0_DOMAIN", "");
  vi.stubEnv("IARA_ALLOWED_EMAILS", "");
  vi.stubEnv("IARA_ADMIN_EMAILS", "");
  vi.stubEnv("IARA_VIEWER_EMAILS", "");
  logs = [];
  fake.request.mockReset();
  fake.endJob.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("refreshDashboard", () => {
  it("fails for a dashboard that is not published", async () => {
    kernel();
    await expect(refreshDashboard({ request: fake.request }, input())).rejects.toThrow("dashboards/sales is not published");
    await expect(refreshDashboard({ request: fake.request }, input("dashboards/nope"))).rejects.toThrow("there is no dashboard nope");
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("renders the initial view once with sign-in off, for everything, and stores it", async () => {
    kernel();
    const p = publish();
    const summary = await refreshDashboard({ request: fake.request }, input());
    expect(summary).toBe("dashboard Sales refreshed (1 render)");
    expect(logs[0]).toBe("rendered for everything · 0 of 2 widgets failed");
    const queries = fake.request.mock.calls.filter((c) => c[0] === "sql.run").map((c) => c[1]);
    expect(queries).toHaveLength(2);
    // the job's name in the history, and no `allow` for a user who reads everything
    expect(queries[0]).toMatchObject({ source: "job nightly" });
    expect(queries[0]).not.toHaveProperty("allow");
    const stored = readSnapshot(p, null);
    expect(Object.keys(stored!.widgets).sort()).toEqual(["chart001", "table001"]);
    expect(stored!.at).toBeGreaterThan(0);
  });

  it("renders once for each set of grants of the people who can open it", async () => {
    kernel();
    vi.stubEnv("IARA_AUTH", "auth0");
    vi.stubEnv("IARA_ALLOWED_EMAILS", "ed@x.com,admin@x.com");
    vi.stubEnv("IARA_ADMIN_EMAILS", "admin@x.com");
    vi.stubEnv("IARA_VIEWER_EMAILS", "v1@x.com");
    fs.writeFileSync(path.join(dataDir, "grants.json"), JSON.stringify({ grants: [{ to: "editors", on: "*" }, { to: "viewers", on: "main.sales" }] }));
    const p = publish();
    expect(await refreshDashboard({ request: fake.request }, input())).toBe("dashboard Sales refreshed (3 renders)");
    expect(logs.filter((l) => l.startsWith("rendered for"))).toEqual([
      "rendered for 1 granted scope · 0 of 2 widgets failed",
      "rendered for everything · 0 of 2 widgets failed",
      "rendered for 1 granted scope · 0 of 2 widgets failed",
    ]);
    const allows = fake.request.mock.calls.filter((c) => c[0] === "sql.run").map((c) => c[1].allow);
    expect(allows).toEqual([["*"], ["*"], undefined, undefined, ["main.sales"], ["main.sales"]]);
    expect(readSnapshot(p, ["*"])).not.toBeNull();
    expect(readSnapshot(p, null)).not.toBeNull();
    expect(readSnapshot(p, ["main.sales"])).not.toBeNull();
    expect(readSnapshot(p, ["main.hr"])).toBeNull();
  });

  it("stores a render with a failed widget without its message, and logs the message", async () => {
    kernel(true);
    const p = publish();
    expect(await refreshDashboard({ request: fake.request }, input())).toBe("dashboard Sales refreshed (1 render)");
    expect(logs[0]).toBe("rendered for everything · 1 of 2 widgets failed");
    expect(logs[1]).toContain("widget table001 failed: CatalogError: table main.secret.costs does not exist");
    const stored = readSnapshot(p, null);
    expect(stored!.widgets.table001).toEqual({ kind: "error", message: HIDDEN_ERROR });
    expect(stored!.widgets.chart001.kind).toBe("chart");
  });

  it("fails when every widget failed, and keeps the render it had", async () => {
    kernel();
    const p = publish();
    await refreshDashboard({ request: fake.request }, input());
    const before = readSnapshot(p, null);
    fake.request.mockImplementation(async () => ({ type: "error", ename: "IOError", evalue: "cluster is gone" }));
    await expect(refreshDashboard({ request: fake.request }, input())).rejects.toThrow("every widget failed (widget chart001 failed: IOError: cluster is gone)");
    expect(readSnapshot(p, null)).toEqual(before);
  });

  it("stores nothing when the task was stopped, and asks the kernel for no more", async () => {
    kernel();
    const p = publish();
    await expect(refreshDashboard({ request: fake.request }, input(), () => true)).rejects.toThrow("interrupted");
    expect(fake.request).not.toHaveBeenCalled();
    expect(readSnapshot(p, null)).toBeNull();
  });

  it("fails when no one can open the dashboard", async () => {
    kernel();
    vi.stubEnv("IARA_AUTH", "auth0");
    publish();
    await expect(refreshDashboard({ request: fake.request }, input())).rejects.toThrow(/no one to render for/);
  });
});

describe("runTask", () => {
  it("refreshes a task whose target is a dashboard folder, on the job's kernel", async () => {
    kernel();
    const p = publish();
    expect(await runTask(input())).toEqual({ status: "succeeded", summary: "dashboard Sales refreshed (1 render)" });
    expect(readSnapshot(p, null)).not.toBeNull();
    expect(fake.endJob).toHaveBeenCalledWith("run1:main");
  });

  it("fails the task, never throws, when the dashboard is not published", async () => {
    kernel();
    expect(await runTask(input())).toEqual({ status: "failed", error: "dashboards/sales is not published" });
  });

  it("is cancelled, and stores nothing, when it is aborted while rendering", async () => {
    const controller = new AbortController();
    fake.request.mockImplementation(async (method: string) => {
      controller.abort("cancelled by user");
      return method === "sql.run" ? { type: "error", ename: "Interrupted", evalue: "interrupted" } : { columns: [], rows: [] };
    });
    const p = publish();
    expect(await runTask({ ...input(), signal: controller.signal })).toEqual({ status: "cancelled", error: "cancelled by user" });
    expect(readSnapshot(p, null)).toBeNull();
  });
});
