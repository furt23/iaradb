import { describe, expect, it, vi } from "vitest";

import type { ExtractEntry, ExtractManifest } from "@/lib/dashboards/extracts";
import type { Dataset, PublishedDashboard } from "@/lib/dashboards/types";

import { sourcesUnchanged, type UnchangedDeps } from "./unchanged";

vi.mock("../kernel/manager", () => ({ kernels: { metadata: vi.fn() } }));
vi.mock("./extractStore", () => ({
  datasetHash: (d: Dataset) => `hash:${d.name}`,
  readManifest: async () => null,
}));

const dataset = (name: string, over: Partial<Dataset> = {}): Dataset => ({ name, sql: `SELECT * FROM tpch.main.${name}`, params: {}, ...over });
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
const entry = (name: string, over: Partial<ExtractEntry> = {}): ExtractEntry => ({
  version: "20261001T000000Z-aaaa",
  rows: 1,
  bytes: 1,
  columns: [],
  sources: ["tpch.main.orders"],
  versions: { "tpch.main.orders": 3 },
  hash: `hash:${name}`,
  refreshed_at: 1,
  ...over,
});

/** deps over a manifest and the tables' current versions */
function deps(manifest: ExtractManifest | null, versions: Record<string, number | null> = { "tpch.main.orders": 3 }): UnchangedDeps {
  return {
    manifest: async () => manifest,
    version: async (table) => versions[table] ?? null,
  };
}

const orders = dataset("orders");

describe("sourcesUnchanged", () => {
  it("is true when every dataset's extract is built from its current definition and the tables are at the same versions", async () => {
    expect(await sourcesUnchanged(published(orders), deps({ datasets: { orders: entry("orders") } }))).toBe(true);
  });

  it("is false when a dataset is live", async () => {
    expect(await sourcesUnchanged(published(dataset("orders", { mode: "live" })), deps({ datasets: { orders: entry("orders") } }))).toBe(false);
  });

  it("is false when a dataset has params", async () => {
    expect(await sourcesUnchanged(published(dataset("orders", { params: { region: { type: "text" } } })), deps({ datasets: { orders: entry("orders") } }))).toBe(false);
  });

  it("is false when there is no dataset", async () => {
    expect(await sourcesUnchanged(published(), deps({ datasets: {} }))).toBe(false);
  });

  it("is false when a dataset has no entry", async () => {
    expect(await sourcesUnchanged(published(orders, dataset("lines")), deps({ datasets: { orders: entry("orders") } }))).toBe(false);
  });

  it("is false when the entry was built from another definition", async () => {
    expect(await sourcesUnchanged(published(orders), deps({ datasets: { orders: entry("orders", { hash: "hash:old" }) } }))).toBe(false);
  });

  it("is false when the entry has no versions, or none at all", async () => {
    const { versions: _, ...bare } = entry("orders");
    expect(await sourcesUnchanged(published(orders), deps({ datasets: { orders: bare } }))).toBe(false);
    expect(await sourcesUnchanged(published(orders), deps({ datasets: { orders: entry("orders", { versions: {} }) } }))).toBe(false);
  });

  it("is false when a table's version differs, or is unknown", async () => {
    const m = { datasets: { orders: entry("orders") } };
    expect(await sourcesUnchanged(published(orders), deps(m, { "tpch.main.orders": 4 }))).toBe(false);
    expect(await sourcesUnchanged(published(orders), deps(m, { "tpch.main.orders": null }))).toBe(false);
  });

  it("is false when the version lookup or the manifest throws", async () => {
    const m = { datasets: { orders: entry("orders") } };
    const failing: UnchangedDeps = { manifest: async () => m, version: async () => { throw new Error("no table"); } };
    expect(await sourcesUnchanged(published(orders), failing)).toBe(false);
    const unread: UnchangedDeps = { manifest: async () => { throw new Error("bucket down"); }, version: async () => 3 };
    expect(await sourcesUnchanged(published(orders), unread)).toBe(false);
  });
});
