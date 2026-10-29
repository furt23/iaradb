import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Dashboard, RenderResult } from "@/lib/dashboards/types";

import type { StudioUser } from "../auth/access";
import { forget } from "../dashboards/cache";
import { datasetHash } from "../dashboards/extractStore";
import { publishDashboard } from "../dashboards/publish";
import { HIDDEN_ERROR } from "../dashboards/run";
import { saveSnapshot } from "../dashboards/snapshots";
import { renderShared } from "./view";

const fake = vi.hoisted(() => ({ request: vi.fn(), serve: vi.fn(), manifest: null as unknown, user: null as unknown, allow: null as unknown }));
vi.mock("../auth/session", () => ({ requireViewer: async () => fake.user }));
// the real one reads the manifest from the workspace's folder: the test chooses what the dashboard has extracted
vi.mock("../dashboards/extractRefresh", () => ({
  servedExtracts: async () => ({ manifest: fake.manifest, serve: fake.serve, url: (dataset: string, version: string) => `s3://bucket/${dataset}/${version}.parquet` }),
}));
vi.mock("../governance/store", () => ({ userAllow: () => fake.allow }));
vi.mock("../kernel/manager", () => ({ kernels: { forDashboard: () => ({ request: fake.request }) } }));

const columns = [{ name: "region", type: "string_view" }];
const dashboard: Dashboard = {
  slug: "sales",
  config: { id: "abcd1234", title: "Sales", refresh_minutes: 5 },
  datasets: [{ name: "sales", sql: "SELECT * FROM sales", params: {} }],
  widgets: [
    { id: "chart001", kind: "chart", dataset: "sales", spec: { kind: "bar", x: "region", y: ["amount"], agg: "sum" } },
    { id: "filter01", kind: "filter", control: "select", fields: [{ dataset: "sales", column: "region" }], value_type: "text" },
  ],
  layout: [],
  problems: [],
};
const stored: RenderResult = { widgets: { chart001: { kind: "chart", data: { columns: ["region"], rows: [["stored"]], truncated: false }, columns } }, at: 123 };

const editor: StudioUser = { email: "ed@x.com", name: "ed", admin: false };

/** a live kernel: its answers have `live` in the data */
function liveKernel() {
  fake.request.mockImplementation(async (method: string) => {
    if (method === "sql.run") return { type: "table", result: { id: "r1", columns, num_rows: 1 } };
    if (method === "result.chart") return { columns: ["region"], rows: [["live"]], truncated: false };
    return { offset: 0, total: 1, rows: [["live"]] };
  });
}

let dataDir: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iara-view-"));
  vi.stubEnv("IARA_STUDIO_DATA", dataDir);
  fake.user = editor;
  fake.allow = ["main.sales"];
  fake.manifest = null;
  fake.request.mockReset();
  fake.serve.mockReset();
  liveKernel();
});
afterEach(() => {
  forget("abcd1234");
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("renderShared", () => {
  it("serves the stored render of the initial view at once, without the kernel", async () => {
    const p = publishDashboard(dashboard, { kind: "team" }, "me");
    saveSnapshot(p, ["main.sales"], stored);
    expect(await renderShared("abcd1234", {}, [])).toEqual({ ok: true, data: stored });
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("renders live when nothing is stored, or it was stored for other grants or for an older publish", async () => {
    const p = publishDashboard(dashboard, { kind: "team" }, "me");
    saveSnapshot(p, ["main.hr"], stored);
    const miss = await renderShared("abcd1234", {}, []);
    expect(miss.ok && miss.data.widgets.chart001).toMatchObject({ kind: "chart", data: { rows: [["live"]] } });
    expect(fake.request).toHaveBeenCalled();

    // the stored render is of the content before this publish
    saveSnapshot(p, ["main.sales"], stored);
    publishDashboard({ ...dashboard, widgets: [...dashboard.widgets, { id: "text0001", kind: "text", markdown: "new" }] }, { kind: "team" }, "me");
    fake.allow = ["main.sales", "main.other"];
    fake.request.mockClear();
    const stale = await renderShared("abcd1234", {}, []);
    expect(stale.ok && stale.data.at).not.toBe(123);
    expect(fake.request).toHaveBeenCalled();
  });

  it("renders live for a view with filter values or chart picks", async () => {
    const p = publishDashboard(dashboard, { kind: "team" }, "me");
    saveSnapshot(p, ["main.sales"], stored);
    const filtered = await renderShared("abcd1234", { filter01: "EU" }, []);
    expect(filtered.ok && filtered.data.at).not.toBe(123);
    expect(fake.request).toHaveBeenCalled();
    fake.request.mockClear();
    const picked = await renderShared("abcd1234", {}, [{ widget: "chart001", value: "EU" }]);
    expect(picked.ok).toBe(true);
    expect(picked.ok && picked.data.at).not.toBe(123);
    expect(fake.request).toHaveBeenCalled();
  });

  it("reads a fresh extract on the serving kernel when the viewer's grants cover its sources, and gives a plain error when they do not", async () => {
    publishDashboard(dashboard, { kind: "team" }, "me");
    fake.manifest = {
      datasets: { sales: { version: "20261028T231500Z-a1b2", rows: 1, bytes: 1, columns, sources: ["main.sales.orders"], hash: datasetHash(dashboard.datasets[0]), refreshed_at: 1 } },
    };
    fake.serve.mockImplementation(async (method: string) => {
      if (method === "sql.run") return { type: "table", result: { id: "s1", columns, num_rows: 1 } };
      if (method === "result.chart") return { columns: ["region"], rows: [["served"]], truncated: false };
      return { offset: 0, total: 1, rows: [["served"]] };
    });
    const r = await renderShared("abcd1234", { filter01: "EU" }, []);
    expect(r.ok && r.data.widgets.chart001).toMatchObject({ kind: "chart", data: { rows: [["served"]] } });
    expect(fake.request).not.toHaveBeenCalled();
    expect(fake.serve.mock.calls[0][1]).toMatchObject({ query: expect.stringContaining("read_parquet('s3://bucket/sales/20261028T231500Z-a1b2.parquet')") });
    expect(fake.serve.mock.calls[0][1]).not.toHaveProperty("allow");

    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.allow = ["main.hr"];
    const hidden = await renderShared("abcd1234", { filter01: "EU" }, []);
    expect(hidden.ok && hidden.data.widgets.chart001).toEqual({ kind: "error", message: HIDDEN_ERROR });
    expect(fake.request).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("still refuses what a browser sends wrong, before the stored render", async () => {
    const p = publishDashboard(dashboard, { kind: "team" }, "me");
    saveSnapshot(p, ["main.sales"], stored);
    expect(await renderShared("abcd1234", [] as never, [])).toMatchObject({ ok: false, error: { message: "the filter values are an object" } });
    expect(await renderShared("abcd1234", { nope: "x" }, [])).toMatchObject({ ok: false, error: { message: "nope is not a filter of this dashboard" } });
    expect(await renderShared("abcd1234", {}, [{ widget: "nope", value: "x" }])).toMatchObject({ ok: false });
    expect(await renderShared("abcd1234", {}, {} as never)).toMatchObject({ ok: false });
  });

  it("does not show a dashboard, or its stored render, to a viewer it is not shared with", async () => {
    const p = publishDashboard(dashboard, { kind: "emails", emails: ["other@x.com"] }, "me");
    saveSnapshot(p, ["main.sales"], stored);
    fake.user = { email: "v@x.com", name: "v", admin: false, viewer: true };
    expect(await renderShared("abcd1234", {}, [])).toMatchObject({ ok: false, error: { type: "NotFound" } });
  });
});
