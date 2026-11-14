import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtractEntry, ExtractManifest } from "@/lib/dashboards/extracts";
import type { Dataset, PublishedDashboard } from "@/lib/dashboards/types";

import { refreshExtracts, servedExtracts } from "./extractRefresh";
import type { RunDeps } from "./run";

const fake = vi.hoisted(() => ({
  manifest: null as unknown,
  readError: null as Error | null,
  order: [] as string[],
  cleanup: vi.fn(),
  serving: vi.fn(),
}));
vi.mock("./cache", () => ({ forget: (id: string) => fake.order.push(`forget ${id}`) }));
vi.mock("../kernel/manager", () => ({ kernels: { serving: fake.serving } }));
vi.mock("./extractStore", () => ({
  datasetHash: (d: Dataset) => `hash:${d.name}:${d.sql}`,
  extractMaxBytes: () => 1000,
  extractUrl: (id: string, dataset: string, version: string) => `s3://b/_iara/extracts/${id}/${dataset}/${version}.parquet`,
  readManifest: async () => {
    if (fake.readError) throw fake.readError;
    return fake.manifest;
  },
  updateManifest: async (_id: string, change: (m: ExtractManifest) => ExtractManifest) => {
    fake.order.push("manifest");
    fake.manifest = change((fake.manifest as ExtractManifest | null) ?? { datasets: {} });
    return fake.manifest;
  },
  cleanupExtracts: async () => {
    fake.order.push("cleanup");
    return fake.cleanup();
  },
}));

const columns = [{ name: "region", type: "string_view" }];
const dataset = (name: string, over: Partial<Dataset> = {}): Dataset => ({ name, sql: `SELECT * FROM ${name};`, params: {}, ...over });
const published = (...datasets: Dataset[]): PublishedDashboard => ({
  id: "abcd1234",
  slug: "sales",
  title: "Sales",
  refresh_minutes: 5,
  datasets,
  widgets: [],
  model: "",
  layout: [],
  share: { kind: "team" },
  publishedBy: "ed@x.com",
  publishedAt: 1,
});
const old = (name: string, over: Partial<ExtractEntry> = {}): ExtractEntry => ({
  version: "20261001T000000Z-aaaa",
  rows: 1,
  bytes: 1,
  columns,
  sources: ["main.public.t"],
  hash: `hash:${name}:old`,
  refreshed_at: 1,
  ...over,
});

let logs: string[];
let written: Record<string, unknown>[];
/** a kernel that writes every extract (rows by dataset name), or fails the datasets named in `fail` */
function kernel(fail: string[] = []) {
  return (async (method: string, params: Record<string, unknown>) => {
    if (method !== "extract.write") throw new Error(`unexpected ${method}`);
    written.push(params);
    const q = String(params.query);
    const bad = fail.find((name) => q.includes(name));
    if (bad) throw new Error(`${bad} is too big`);
    return { rows: q.includes("orders") ? 120345 : 3, bytes: 3456789, columns, sources: ["main.public.orders"] };
  }) as RunDeps["request"];
}
const deps = (request: RunDeps["request"], over: object = {}) => ({ request, log: (l: string) => void logs.push(l), stopped: () => false, allow: null, source: "job nightly", ...over });
const entries = () => (fake.manifest as ExtractManifest).datasets;

beforeEach(() => {
  fake.manifest = null;
  fake.readError = null;
  fake.order = [];
  fake.cleanup.mockReset();
  fake.serving.mockReset();
  logs = [];
  written = [];
});

describe("refreshExtracts", () => {
  it("writes each dataset that wants an extract, one after another, and swaps them into the manifest, then cleans up and forgets the renders", async () => {
    const r = await refreshExtracts(published(dataset("orders"), dataset("stores")), deps(kernel()));
    expect(r).toEqual({ built: 2, failed: 0 });
    // the query without its `;`, the file of a new version, the grants of an unchecked publisher as everything
    expect(written).toEqual([
      { query: "SELECT * FROM orders", path: expect.stringMatching(/^s3:\/\/b\/_iara\/extracts\/abcd1234\/orders\/\d{8}T\d{6}Z-[0-9a-f]{4}\.parquet$/), allow: ["*"], max_bytes: 1000, source: "job nightly" },
      { query: "SELECT * FROM stores", path: expect.stringMatching(/\/stores\/\d{8}T\d{6}Z-[0-9a-f]{4}\.parquet$/), allow: ["*"], max_bytes: 1000, source: "job nightly" },
    ]);
    expect(logs).toEqual(["orders: 120,345 rows, 3.3 MB", "stores: 3 rows, 3.3 MB"]);
    const orders = entries().orders;
    expect(orders).toMatchObject({ rows: 120345, bytes: 3456789, columns, sources: ["main.public.orders"], hash: "hash:orders:SELECT * FROM orders;" });
    expect(orders.version).toBe((written[0].path as string).split("/").pop()!.replace(".parquet", ""));
    expect(orders).not.toHaveProperty("previous");
    expect(orders.refreshed_at).toBeGreaterThan(Date.now() - 60_000);
    expect(Object.keys(entries())).toEqual(["orders", "stores"]);
    expect(fake.order).toEqual(["manifest", "forget abcd1234", "cleanup"]);
  });

  it("asks for the publisher's grants, and records the version it replaces", async () => {
    fake.manifest = { datasets: { orders: old("orders") } };
    await refreshExtracts(published(dataset("orders")), deps(kernel(), { allow: ["main.public"] }));
    expect(written[0].allow).toEqual(["main.public"]);
    expect(entries().orders.previous).toBe("20261001T000000Z-aaaa");
    expect(entries().orders.version).not.toBe("20261001T000000Z-aaaa");
  });

  it("leaves live datasets and datasets with params alone, and drops the entries of datasets that are gone or no longer want one", async () => {
    fake.manifest = { datasets: { orders: old("orders"), gone: old("gone"), pinned: old("pinned"), param: old("param") } };
    const p = published(dataset("orders"), dataset("pinned", { mode: "live" }), dataset("param", { sql: "SELECT * FROM t WHERE y = :y", params: { y: { type: "number" } } }));
    expect(await refreshExtracts(p, deps(kernel()))).toEqual({ built: 1, failed: 0 });
    expect(written).toHaveLength(1);
    expect(Object.keys(entries())).toEqual(["orders"]);
  });

  it("logs a dataset that fails, counts it, keeps its old extract, and builds the others", async () => {
    fake.manifest = { datasets: { orders: old("orders"), stores: old("stores") } };
    const r = await refreshExtracts(published(dataset("orders"), dataset("stores"), dataset("fresh")), deps(kernel(["orders"])));
    expect(r).toEqual({ built: 2, failed: 1 });
    expect(logs[0]).toBe("orders failed: orders is too big");
    expect(entries().orders).toEqual(old("orders"));
    expect(entries().stores.previous).toBe("20261001T000000Z-aaaa");
    expect(entries().fresh.version).toMatch(/Z-/);
  });

  it("fails a dataset that is not one query without asking the kernel", async () => {
    const r = await refreshExtracts(published(dataset("two", { sql: "SELECT 1; SELECT 2" }), dataset("recipe", { sql: "" })), deps(kernel()));
    expect(r).toEqual({ built: 0, failed: 2 });
    expect(written).toEqual([]);
    expect(logs).toEqual(["two failed: a dataset holds one query", "recipe failed: a dataset holds one query"]);
  });

  it("stops at the next dataset once stopped, and keeps what was built", async () => {
    let calls = 0;
    const d = deps(kernel(), { stopped: () => calls++ >= 1 });
    expect(await refreshExtracts(published(dataset("orders"), dataset("stores")), d)).toEqual({ built: 1, failed: 0 });
    expect(written).toHaveLength(1);
    expect(Object.keys(entries())).toEqual(["orders"]);
  });

  it("does not fail the refresh when the old files cannot be removed", async () => {
    fake.cleanup.mockRejectedValue(new Error("access denied"));
    expect(await refreshExtracts(published(dataset("orders")), deps(kernel()))).toEqual({ built: 1, failed: 0 });
    expect(logs.at(-1)).toBe("old extracts not removed: access denied");
  });
});

describe("servedExtracts", () => {
  it("gives the manifest, the serving kernel and the URL of a version's file", async () => {
    fake.manifest = { datasets: { orders: old("orders") } };
    fake.serving.mockResolvedValue("answer");
    const x = await servedExtracts("abcd1234", "ana@example.com");
    expect(x.manifest).toBe(fake.manifest);
    expect(x.url("orders", "20261001T000000Z-aaaa")).toBe("s3://b/_iara/extracts/abcd1234/orders/20261001T000000Z-aaaa.parquet");
    expect(await x.serve("result.page", { result_id: "r1", offset: 0, limit: 5 })).toBe("answer");
    expect(fake.serving).toHaveBeenCalledWith("result.page", { result_id: "r1", offset: 0, limit: 5 }, "ana@example.com");
  });

  it("takes a manifest that cannot be read as none, and logs why, so the datasets run live", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.readError = new Error("the extracts manifest of dashboard abcd1234 is damaged: datasets is an object");
    const x = await servedExtracts("abcd1234");
    expect(x.manifest).toBeNull();
    expect(log).toHaveBeenCalledWith("dashboard abcd1234: extracts manifest not read, its datasets run live: the extracts manifest of dashboard abcd1234 is damaged: datasets is an object");
    expect(x.url("orders", "20261001T000000Z-aaaa")).toContain("/abcd1234/orders/");
    log.mockRestore();
  });
});
