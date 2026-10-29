import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ExtractEntry, type ExtractManifest, newVersion } from "@/lib/dashboards/extracts";
import type { Dataset } from "@/lib/dashboards/types";

/** An S3 bucket as the store uses it: conditional writes (412 when they fail), listings in pages of `pageSize`. */
const s3 = vi.hoisted(() => ({
  objects: new Map<string, { body: string; etag: string }>(),
  n: 0,
  puts: [] as Record<string, string | undefined>[],
  pageSize: 2,
  /** runs before the next write is judged, once: another Studio getting there first */
  beforePut: null as (() => void) | null,
}));

vi.mock("@aws-sdk/client-s3", () => {
  type Input = Record<string, string | undefined>;
  class Command {
    constructor(public input: Input) {}
  }
  class GetObjectCommand extends Command {}
  class PutObjectCommand extends Command {}
  class ListObjectsV2Command extends Command {}
  class DeleteObjectCommand extends Command {}
  class S3Client {
    async send(c: Command) {
      const i = c.input;
      const key = i.Key as string;
      if (c instanceof GetObjectCommand) {
        const o = s3.objects.get(key);
        if (!o) throw Object.assign(new Error("no such key"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
        return { Body: { transformToString: async () => o.body }, ETag: o.etag };
      }
      if (c instanceof PutObjectCommand) {
        const hook = s3.beforePut;
        s3.beforePut = null;
        hook?.();
        s3.puts.push(i);
        const o = s3.objects.get(key);
        const refused = i.IfNoneMatch === "*" ? !!o : i.IfMatch !== undefined ? o?.etag !== i.IfMatch : false;
        if (refused) throw Object.assign(new Error("precondition failed"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
        const etag = `"etag-${++s3.n}"`;
        s3.objects.set(key, { body: i.Body as string, etag });
        return { ETag: etag };
      }
      if (c instanceof ListObjectsV2Command) {
        const keys = [...s3.objects.keys()].filter((k) => k.startsWith(i.Prefix as string)).sort();
        const from = Number(i.ContinuationToken ?? 0);
        const more = from + s3.pageSize < keys.length;
        return { Contents: keys.slice(from, from + s3.pageSize).map((Key) => ({ Key })), IsTruncated: more, NextContinuationToken: more ? String(from + s3.pageSize) : undefined };
      }
      if (c instanceof DeleteObjectCommand) {
        s3.objects.delete(key);
        return {};
      }
      throw new Error("unexpected command");
    }
  }
  return { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand };
});

type Store = typeof import("./extractStore");

const ID = "abcd1234";
const V1 = "20200101T000000Z-aaaa";
const V2 = "20200102T000000Z-bbbb";
const V3 = "20200103T000000Z-cccc";
const V0 = "20191231T000000Z-zzzz";

const entry = (version: string, previous?: string, rows = 3): ExtractEntry => ({
  version,
  ...(previous ? { previous } : {}),
  rows,
  bytes: 100,
  columns: [{ name: "a", type: "int64" }],
  sources: ["main.main.t"],
  hash: "h",
  refreshed_at: 1,
});

let workspace: string;
let store: Store;

async function load(bucket: string) {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "iara-extracts-"));
  vi.stubEnv("IARA_WORKSPACE", workspace);
  vi.stubEnv("IARA_BUCKET", bucket);
  vi.resetModules(); // the workspace and the bucket are read from the environment when the config loads
  store = await import("./extractStore");
}

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

const dir = (...p: string[]) => path.join(workspace, ".iara", "extracts", ID, ...p);
const touch = (rel: string) => {
  fs.mkdirSync(path.dirname(dir(rel)), { recursive: true });
  fs.writeFileSync(dir(rel), "x");
};
const files = (sub = ""): string[] => (fs.existsSync(dir(sub)) ? fs.readdirSync(dir(sub), { recursive: true }).map((n) => String(n).replaceAll("\\", "/")).sort() : []);

describe("datasetHash", () => {
  beforeEach(() => load(""));

  const sql: Dataset = { name: "orders", sql: "SELECT * FROM main.orders", params: {} };
  const recipe: Dataset = { name: "orders", sql: "", params: {}, recipe: { source: { table: "main.orders" }, steps: [] } };

  it("is a stable sha1, whatever surrounds the SQL", () => {
    expect(store.datasetHash(sql)).toMatch(/^[0-9a-f]{40}$/);
    expect(store.datasetHash(sql)).toBe(store.datasetHash({ ...sql }));
    expect(store.datasetHash({ ...sql, sql: "\n  SELECT * FROM main.orders \n" })).toBe(store.datasetHash(sql));
  });

  it("differs when the SQL changes, and between SQL and a recipe", () => {
    expect(store.datasetHash({ ...sql, sql: "SELECT 1" })).not.toBe(store.datasetHash(sql));
    expect(store.datasetHash(recipe)).not.toBe(store.datasetHash(sql));
  });

  it("is the recipe's when there is one, and changes with its steps", () => {
    const more: Dataset = { ...recipe, recipe: { source: { table: "main.orders" }, steps: [{ id: "s1", label: "Keep EU", enabled: true, op: { kind: "filter", column: "region", value: "EU" } }] } };
    expect(store.datasetHash(more)).not.toBe(store.datasetHash(recipe));
    // the compiled SQL a recipe dataset carries is not what it is
    expect(store.datasetHash({ ...recipe, sql: "SELECT * FROM main.orders" })).toBe(store.datasetHash(recipe));
  });
});

describe("extractMaxBytes", () => {
  beforeEach(() => load(""));

  it("is 100 MB, or IARA_EXTRACT_MAX_MB", () => {
    expect(store.extractMaxBytes()).toBe(100 * 1024 * 1024);
    vi.stubEnv("IARA_EXTRACT_MAX_MB", "5");
    expect(store.extractMaxBytes()).toBe(5 * 1024 * 1024);
    vi.stubEnv("IARA_EXTRACT_MAX_MB", "0.5");
    expect(store.extractMaxBytes()).toBe(512 * 1024);
  });

  it("is 100 MB when the setting is not a positive number", () => {
    for (const bad of ["", "abc", "0", "-3"]) {
      vi.stubEnv("IARA_EXTRACT_MAX_MB", bad);
      expect(store.extractMaxBytes()).toBe(100 * 1024 * 1024);
    }
  });
});

describe("local extracts", () => {
  beforeEach(() => load(""));

  it("name a version by an absolute path in the workspace's hidden folder", () => {
    const url = store.extractUrl(ID, "orders", V1);
    expect(url).toBe(path.join(workspace, ".iara", "extracts", ID, "orders", `${V1}.parquet`));
    expect(path.isAbsolute(url)).toBe(true);
  });

  it("refuse names that could leave their folder", async () => {
    expect(() => store.extractUrl("../x", "orders", V1)).toThrow(/invalid dashboard id/);
    expect(() => store.extractUrl(ID, "../x", V1)).toThrow(/invalid dataset name/);
    expect(() => store.extractUrl(ID, "orders", "../x")).toThrow(/invalid extract version/);
    for (const call of [store.readManifest, store.cleanupExtracts, store.deleteExtracts]) await expect(call("../x")).rejects.toThrow(/invalid dashboard id/);
    await expect(store.updateManifest("../x", (m) => m)).rejects.toThrow(/invalid dashboard id/);
  });

  it("keep a manifest that is read back as it was written", async () => {
    expect(await store.readManifest(ID)).toBeNull();
    const written = await store.updateManifest(ID, (m) => {
      expect(m).toEqual({ datasets: {} });
      return { datasets: { ...m.datasets, orders: entry(V2, V1) } };
    });
    expect(written).toEqual({ datasets: { orders: entry(V2, V1) } });
    expect(await store.readManifest(ID)).toEqual(written);
    // atomic: no temp file is left, and the file is JSON
    expect(files()).toEqual(["manifest.json"]);
    expect(JSON.parse(fs.readFileSync(dir("manifest.json"), "utf8"))).toEqual(written);
  });

  it("apply the changes of calls made together in order, none lost", async () => {
    const calls = Array.from({ length: 12 }, (_, i) => store.updateManifest(ID, (m) => ({ datasets: { ...m.datasets, [`d${i}`]: entry(V1, undefined, Object.keys(m.datasets).length) } })));
    await Promise.all(calls);
    const m = (await store.readManifest(ID))!;
    expect(Object.keys(m.datasets)).toEqual(Array.from({ length: 12 }, (_, i) => `d${i}`));
    // each change saw the manifest the one before left
    expect(Object.values(m.datasets).map((e) => e.rows)).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  it("go on after a change that fails, writing nothing for it", async () => {
    await store.updateManifest(ID, () => ({ datasets: { orders: entry(V1) } }));
    const failing = store.updateManifest(ID, () => {
      throw new Error("no");
    });
    const after = store.updateManifest(ID, (m) => ({ datasets: { ...m.datasets, sales: entry(V2) } }));
    await expect(failing).rejects.toThrow("no");
    expect(Object.keys((await after).datasets)).toEqual(["orders", "sales"]);
  });

  it("refuse to write a manifest readers would refuse", async () => {
    await store.updateManifest(ID, () => ({ datasets: { orders: entry(V1) } }));
    await expect(store.updateManifest(ID, () => ({ datasets: { "../x": entry(V1) } }))).rejects.toThrow(/not a dataset name/);
    await expect(store.updateManifest(ID, () => ({ datasets: { orders: entry("../x") } }))).rejects.toThrow(/not a version/);
    expect(await store.readManifest(ID)).toEqual({ datasets: { orders: entry(V1) } });
  });

  it("throw on a damaged manifest and leave it alone", async () => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(dir("manifest.json"), "{not json");
    await expect(store.readManifest(ID)).rejects.toThrow(/manifest of dashboard abcd1234 is damaged/);
    await expect(store.updateManifest(ID, (m) => m)).rejects.toThrow(/is damaged/);
    await expect(store.cleanupExtracts(ID)).rejects.toThrow(/is damaged/);
    fs.writeFileSync(dir("manifest.json"), JSON.stringify({ datasets: { orders: { ...entry(V1), rows: "many" } } }));
    await expect(store.readManifest(ID)).rejects.toThrow(/is damaged/);
    expect(fs.readFileSync(dir("manifest.json"), "utf8")).toContain("many");
  });

  describe("cleanup", () => {
    const fly = newVersion(Date.now(), "fly1");

    it("keeps version and previous, deletes the other versions and the orphans", async () => {
      await store.updateManifest(ID, () => ({ datasets: { orders: entry(V3, V2) } }));
      for (const v of [V0, V1, V2, V3]) touch(`orders/${v}.parquet`);
      touch(`sales/${V1}.parquet`); // a dataset the manifest does not list: a failed first refresh
      touch(`orders/${V1}.txt`); // not an extract
      await store.cleanupExtracts(ID);
      expect(files()).toEqual(["manifest.json", "orders", `orders/${V1}.txt`, `orders/${V2}.parquet`, `orders/${V3}.parquet`, "sales"]);
    });

    it("leaves other dashboards' extracts alone", async () => {
      await store.updateManifest(ID, () => ({ datasets: { orders: entry(V3) } }));
      touch(`orders/${V1}.parquet`);
      const other = path.join(workspace, ".iara", "extracts", "wxyz5678", "orders", `${V1}.parquet`);
      fs.mkdirSync(path.dirname(other), { recursive: true });
      fs.writeFileSync(other, "x");
      await store.cleanupExtracts(ID);
      expect(files("orders")).toEqual([]);
      expect(fs.existsSync(other)).toBe(true);
    });

    it("deletes every old file when there is no manifest, and does nothing when there is nothing", async () => {
      await expect(store.cleanupExtracts(ID)).resolves.toBeUndefined();
      touch(`orders/${V1}.parquet`);
      await store.cleanupExtracts(ID);
      expect(files("orders")).toEqual([]);
    });

    it("keeps a recent file newer than its dataset's version: a refresh may still be running", async () => {
      await store.updateManifest(ID, () => ({ datasets: { orders: entry(V3) } }));
      touch(`orders/${fly}.parquet`);
      touch(`sales/${fly}.parquet`);
      await store.cleanupExtracts(ID);
      expect(files()).toEqual(["manifest.json", "orders", `orders/${fly}.parquet`, "sales", `sales/${fly}.parquet`]);
      // once the manifest names a newer version, the file it replaced is not in flight
      await store.updateManifest(ID, () => ({ datasets: { orders: entry(newVersion(Date.now() + 1000, "next"), fly) } }));
      touch(`orders/${V3}.parquet`);
      await store.cleanupExtracts(ID);
      expect(files("orders")).toEqual([`${fly}.parquet`]);
    });
  });

  it("delete everything of a dashboard's extracts, and only its", async () => {
    await store.updateManifest(ID, () => ({ datasets: { orders: entry(V2, V1) } }));
    touch(`orders/${V1}.parquet`);
    touch(`orders/${V2}.parquet`);
    const other = path.join(workspace, ".iara", "extracts", "wxyz5678", "manifest.json");
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, "{}");
    await store.deleteExtracts(ID);
    expect(fs.existsSync(dir())).toBe(false);
    expect(await store.readManifest(ID)).toBeNull();
    expect(fs.existsSync(other)).toBe(true);
    await expect(store.deleteExtracts(ID)).resolves.toBeUndefined();
  });
});

describe("extracts in the team bucket", () => {
  const key = (...p: string[]) => ["_iara/extracts", ID, ...p].join("/");
  const put = (rel: string) => s3.objects.set(key(rel), { body: "x", etag: `"p${++s3.n}"` });
  const keys = () => [...s3.objects.keys()].sort();

  beforeEach(async () => {
    s3.objects.clear();
    s3.n = 0;
    s3.puts = [];
    s3.beforePut = null;
    s3.pageSize = 2;
    await load("team-data");
  });

  it("name a version by an s3 URL", () => {
    expect(store.extractUrl(ID, "orders", V1)).toBe(`s3://team-data/_iara/extracts/${ID}/orders/${V1}.parquet`);
  });

  it("write the manifest if none exists, then only over the version they read", async () => {
    expect(await store.readManifest(ID)).toBeNull();
    await store.updateManifest(ID, () => ({ datasets: { orders: entry(V1) } }));
    expect(s3.puts[0]).toMatchObject({ Bucket: "team-data", Key: key("manifest.json"), IfNoneMatch: "*", ContentType: "application/json" });
    expect(s3.puts[0]).not.toHaveProperty("IfMatch");
    await store.updateManifest(ID, (m) => ({ datasets: { ...m.datasets, sales: entry(V2) } }));
    expect(s3.puts[1]).toMatchObject({ IfMatch: '"etag-1"' });
    expect(s3.puts[1]).not.toHaveProperty("IfNoneMatch");
    expect(Object.keys((await store.readManifest(ID))!.datasets)).toEqual(["orders", "sales"]);
  });

  it("start over from what another Studio wrote when they lose the race", async () => {
    await store.updateManifest(ID, () => ({ datasets: { orders: entry(V1) } }));
    s3.beforePut = () => s3.objects.set(key("manifest.json"), { body: JSON.stringify({ datasets: { orders: entry(V1), hr: entry(V1) } }), etag: '"other"' });
    let runs = 0;
    const out = await store.updateManifest(ID, (m) => {
      runs++;
      return { datasets: { ...m.datasets, sales: entry(V2) } };
    });
    expect(runs).toBe(2);
    expect(Object.keys(out.datasets)).toEqual(["orders", "hr", "sales"]);
    expect(Object.keys((await store.readManifest(ID))!.datasets)).toEqual(["orders", "hr", "sales"]);
  });

  it("give up after a few lost races", async () => {
    await store.updateManifest(ID, () => ({ datasets: {} }));
    let runs = 0;
    const racing = (m: ExtractManifest) => {
      runs++;
      s3.beforePut = () => s3.objects.set(key("manifest.json"), { body: JSON.stringify(m), etag: `"other${runs}"` });
      return m;
    };
    await expect(store.updateManifest(ID, racing)).rejects.toThrow("changed by another writer");
    expect(runs).toBe(5);
  });

  it("clean up through every page of the listing, deleting only unnamed Parquet files of the dashboard", async () => {
    await store.updateManifest(ID, () => ({ datasets: { orders: entry(V3, V2) } }));
    for (const v of [V0, V1, V2, V3]) put(`orders/${v}.parquet`);
    put(`sales/${V1}.parquet`);
    s3.objects.set(`_iara/extracts/wxyz5678/orders/${V1}.parquet`, { body: "x", etag: '"o"' });
    await store.cleanupExtracts(ID);
    expect(keys()).toEqual([key("manifest.json"), key("orders", `${V2}.parquet`), key("orders", `${V3}.parquet`), `_iara/extracts/wxyz5678/orders/${V1}.parquet`]);
  });

  it("delete everything of a dashboard, the manifest too", async () => {
    await store.updateManifest(ID, () => ({ datasets: { orders: entry(V2) } }));
    for (const v of [V1, V2]) put(`orders/${v}.parquet`);
    s3.objects.set(`_iara/extracts/wxyz5678/manifest.json`, { body: "{}", etag: '"o"' });
    await store.deleteExtracts(ID);
    expect(keys()).toEqual([`_iara/extracts/wxyz5678/manifest.json`]);
    expect(await store.readManifest(ID)).toBeNull();
  });
});
