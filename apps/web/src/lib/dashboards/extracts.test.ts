import { describe, expect, it } from "vitest";

import { checkManifest, covers, emptyManifest, type ExtractEntry, type ExtractManifest, freshEntry, newVersion, uncovered, VERSION, wantsExtract } from "./extracts";
import type { Dataset } from "./types";

const entry: ExtractEntry = {
  version: "20261028T231500Z-a1b2",
  previous: "20261028T221500Z-c3d4",
  rows: 120345,
  bytes: 3456789,
  columns: [{ name: "order_date", type: "date32" }],
  sources: ["tpch.main.orders"],
  hash: "abc123",
  refreshed_at: 1761693300000,
};
const manifest: ExtractManifest = { datasets: { orders: entry } };

describe("emptyManifest", () => {
  it("lists no dataset, and is new each time", () => {
    expect(emptyManifest()).toEqual({ datasets: {} });
    expect(emptyManifest()).not.toBe(emptyManifest());
  });
});

describe("checkManifest", () => {
  it("takes what a manifest is, as it was parsed", () => {
    expect(checkManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
    expect(checkManifest({ datasets: {} })).toEqual(emptyManifest());
  });

  it("does not need a previous version", () => {
    const { previous: _, ...first } = entry;
    expect(checkManifest({ datasets: { orders: first } })).toEqual({ datasets: { orders: first } });
  });

  it("takes the versions of the base tables, and an entry without them", () => {
    const withVersions = { ...entry, versions: { "tpch.main.orders": 3, "tpch.main.lines": 0 } };
    expect(checkManifest({ datasets: { orders: withVersions } })).toEqual({ datasets: { orders: withVersions } });
    expect(checkManifest({ datasets: { orders: entry } }).datasets.orders.versions).toBeUndefined();
  });

  it("refuses versions that are not an object of whole numbers, 0 or more", () => {
    for (const bad of [null, [], "3", { "a.b.c": "3" }, { "a.b.c": 1.5 }, { "a.b.c": -1 }, { "a.b.c": null }]) {
      expect(() => checkManifest({ datasets: { orders: { ...entry, versions: bad } } }), JSON.stringify(bad)).toThrow(/versions/);
    }
  });

  it("is rebuilt with the known keys only", () => {
    const out = checkManifest({ other: 1, datasets: { orders: { ...entry, extra: "x", columns: [{ name: "a", type: "int64", more: 1 }] } } });
    expect(out).toEqual({ datasets: { orders: { ...entry, columns: [{ name: "a", type: "int64" }] } } });
  });

  it("refuses what is not a manifest", () => {
    for (const bad of [null, "x", [], 1, {}, { datasets: [] }, { datasets: null }]) expect(() => checkManifest(bad)).toThrow();
  });

  it("refuses dataset names and versions that could not be used in a path", () => {
    for (const name of ["../x", "a/b", "A", "", "a b", "x".repeat(65)]) {
      expect(() => checkManifest({ datasets: { [name]: entry } })).toThrow(/not a dataset name/);
    }
    for (const v of ["../x", "20261028T231500Z", "20261028T231500Z-", "20261028T231500Z-A1", "20261028T231500Z-a/b", "x"]) {
      expect(() => checkManifest({ datasets: { orders: { ...entry, version: v } } })).toThrow(/version is not a version/);
      expect(() => checkManifest({ datasets: { orders: { ...entry, previous: v } } })).toThrow(/previous is not a version/);
    }
  });

  it("refuses fields of the wrong type", () => {
    const bad: Record<string, unknown> = {
      rows: "3",
      bytes: -1,
      columns: [{ name: "a" }],
      sources: [1],
      hash: 5,
      refreshed_at: Number.NaN,
    };
    for (const [key, value] of Object.entries(bad)) expect(() => checkManifest({ datasets: { orders: { ...entry, [key]: value } } }), key).toThrow();
    expect(() => checkManifest({ datasets: { orders: null } })).toThrow();
  });

  it("keeps a dataset called __proto__ as a key", () => {
    const out = checkManifest(JSON.parse(`{"datasets":{"__proto__":${JSON.stringify(entry)}}}`));
    expect(Object.keys(out.datasets)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(out.datasets)).toBe(Object.prototype);
  });
});

describe("newVersion", () => {
  it("is the UTC time, then the random part", () => {
    expect(newVersion(Date.UTC(2026, 9, 28, 23, 15, 0, 789), "a1b2")).toBe("20261028T231500Z-a1b2");
    expect(newVersion(Date.UTC(2026, 0, 2, 3, 4, 5), "z")).toBe("20260102T030405Z-z");
  });

  it("differs for two refreshes in one second, and is a version", () => {
    const now = Date.UTC(2026, 9, 28, 23, 15, 0);
    expect(newVersion(now, "aaaa")).not.toBe(newVersion(now, "bbbb"));
    expect(newVersion(now, "a1b2")).toMatch(VERSION);
  });

  it("sorts by time", () => {
    expect(newVersion(Date.UTC(2026, 9, 28), "z") < newVersion(Date.UTC(2026, 10, 1), "a")).toBe(true);
  });

  it("refuses a random part that is not [a-z0-9]+", () => {
    for (const r of ["", "A", "a-b", "../x", "a b"]) expect(() => newVersion(0, r)).toThrow();
  });
});

describe("wantsExtract", () => {
  const dataset: Dataset = { name: "orders", sql: "SELECT * FROM main.orders", params: {} };

  it("is a dataset that is not live and has no params", () => {
    expect(wantsExtract(dataset)).toBe(true);
    expect(wantsExtract({ name: "r", sql: "", params: {}, recipe: { source: { table: "main.orders" }, steps: [] } })).toBe(true);
  });

  it("is not a live dataset", () => {
    expect(wantsExtract({ ...dataset, mode: "live" })).toBe(false);
  });

  it("is not a dataset with params of its own, declared or only written in the SQL", () => {
    expect(wantsExtract({ ...dataset, sql: "SELECT * FROM main.orders WHERE region = :region", params: {} })).toBe(false);
    expect(wantsExtract({ ...dataset, params: { region: { type: "text" } } })).toBe(false);
  });

  it("is not fooled by a cast, a string or a comment", () => {
    expect(wantsExtract({ ...dataset, sql: "SELECT a::int, ':x' AS s FROM main.orders -- :y" })).toBe(true);
  });
});

describe("covers", () => {
  it("is everything when there is no list", () => {
    expect(covers(null, "tpch.main.orders")).toBe(true);
    expect(covers(undefined, "tpch.main.orders")).toBe(true);
  });

  it("follows * , catalog, schema and table entries", () => {
    expect(covers(["*"], "tpch.main.orders")).toBe(true);
    expect(covers(["tpch"], "tpch.main.orders")).toBe(true);
    expect(covers(["tpch.main"], "tpch.main.orders")).toBe(true);
    expect(covers(["tpch.main.orders"], "tpch.main.orders")).toBe(true);
    expect(covers(["other", "tpch.main.orders"], "tpch.main.orders")).toBe(true);
  });

  it("does not cover what is outside the entries, nor a longer name that starts like one", () => {
    expect(covers([], "tpch.main.orders")).toBe(false);
    expect(covers(["tpch.main.line"], "tpch.main.lineitem")).toBe(false);
    expect(covers(["tp"], "tpch.main.orders")).toBe(false);
    expect(covers(["tpch.sales"], "tpch.main.orders")).toBe(false);
    expect(covers(["tpch.main.orders.x"], "tpch.main.orders")).toBe(false);
    expect(covers([""], "tpch.main.orders")).toBe(false);
  });

  it("compares lowercase, ignoring spaces around entries", () => {
    expect(covers([" TPCH.Main "], "tpch.main.Orders")).toBe(true);
    expect(covers(["tpch.main.orders"], "TPCH.MAIN.ORDERS")).toBe(true);
  });
});

describe("freshEntry", () => {
  it("is the entry built from the same definition", () => {
    expect(freshEntry(manifest, "orders", "abc123")).toBe(entry);
  });

  it("is null when the manifest or the dataset is missing, or the definition changed", () => {
    expect(freshEntry(null, "orders", "abc123")).toBeNull();
    expect(freshEntry(manifest, "sales", "abc123")).toBeNull();
    expect(freshEntry(manifest, "orders", "other")).toBeNull();
  });

  it("does not find what Object has", () => {
    for (const name of ["constructor", "__proto__", "toString"]) expect(freshEntry(manifest, name, "abc123")).toBeNull();
  });
});

describe("uncovered", () => {
  const two = { ...entry, sources: ["tpch.main.orders", "tpch.hr.salaries"] };

  it("is null when every source is covered", () => {
    expect(uncovered(two, null)).toBeNull();
    expect(uncovered(two, ["tpch"])).toBeNull();
    expect(uncovered({ ...entry, sources: [] }, [])).toBeNull();
  });

  it("is the first source that is not", () => {
    expect(uncovered(two, ["tpch.main"])).toBe("tpch.hr.salaries");
    expect(uncovered(two, [])).toBe("tpch.main.orders");
  });
});
