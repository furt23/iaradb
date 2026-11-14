import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";

import { kernelConfig } from "./catalogConfig";

const TEAM = { name: "team", bucket: "team-data", endpoint: "https://acc.r2.cloudflarestorage.com", region: "auto" };
const LOCAL = { name: "folder", bucket: null, endpoint: null, region: "auto" };
const TEXT = `# the catalog
[workspace]
name = "demo"

[tables.sales]
path = "s3://team-data/sales/"
`;

describe("kernelConfig", () => {
  it("leaves the text alone in local mode", () => {
    expect(kernelConfig(TEXT, LOCAL)).toBe(TEXT);
  });

  it("names the workspace when the text names none, so kernels and the Studio agree on the default catalog", () => {
    const cfg = parse(kernelConfig(`[tables.sales]\npath = "a"\n`, LOCAL));
    expect(cfg.workspace).toEqual({ name: "folder" });
    expect(cfg.tables).toEqual({ sales: { path: "a" } });
    expect((parse(kernelConfig(`[workspace]\nwarehouse = "wh"\n`, TEAM)).workspace as { name: string }).name).toBe("team");
  });

  it("adds the warehouse of the team bucket", () => {
    const cfg = parse(kernelConfig(TEXT, { ...TEAM, endpoint: null }));
    expect(cfg.workspace).toEqual({ name: "demo", warehouse: "s3://team-data/warehouse" });
    expect(cfg.storage).toBeUndefined();
    expect(cfg.tables).toEqual({ sales: { path: "s3://team-data/sales/" } });
  });

  it("adds the bucket's storage when there is an endpoint", () => {
    const cfg = parse(kernelConfig(TEXT, { ...TEAM }));
    expect(cfg.storage).toEqual({ "s3://team-data": { endpoint: TEAM.endpoint, region: "auto" } });
    expect(cfg.workspace).toEqual({ name: "demo", warehouse: "s3://team-data/warehouse" });
  });

  it("adds no storage section for cluster kernels (no endpoint), but the name and the warehouse", () => {
    const cfg = parse(kernelConfig(`[tables.sales]\npath = "s3://team-data/sales/"\n`, { ...TEAM, endpoint: null }));
    expect(cfg.storage).toBeUndefined();
    expect(cfg.workspace).toEqual({ name: "team", warehouse: "s3://team-data/warehouse" });
  });

  it("keeps a warehouse the text sets", () => {
    const text = `[workspace]\nname = "demo"\nwarehouse = "s3://other/wh"\n`;
    const cfg = parse(kernelConfig(text, { ...TEAM }));
    expect((cfg.workspace as { warehouse: string }).warehouse).toBe("s3://other/wh");
  });

  it("keeps a storage section the text sets for the bucket", () => {
    const text = `${TEXT}\n[storage."s3://team-data"]\nendpoint = "https://mine.example.com"\nregion = "eu-west-1"\n`;
    const cfg = parse(kernelConfig(text, { ...TEAM }));
    expect(cfg.storage).toEqual({ "s3://team-data": { endpoint: "https://mine.example.com", region: "eu-west-1" } });
  });

  it("returns the text unchanged when nothing is generated", () => {
    const text = `[workspace]\nname = "demo"\nwarehouse = "s3://x/wh"\n\n[storage."s3://team-data"]\nendpoint = "https://e"\n`;
    expect(kernelConfig(text, { ...TEAM })).toBe(text);
  });

  it("returns an unparseable text unchanged", () => {
    const broken = `[workspace\nname = `;
    expect(kernelConfig(broken, { ...TEAM })).toBe(broken);
  });

  it("declares the system catalog with one table, as Parquet folders", () => {
    const cfg = parse(kernelConfig(TEXT, { ...LOCAL, system: [{ name: "queries", path: "/ws/.iara/system/queries" }] }));
    expect(cfg.catalogs).toEqual({
      system: {
        description: "The Studio's own records (read-only)",
        tables: { queries: { path: "/ws/.iara/system/queries", format: "parquet" } },
      },
    });
    expect(cfg.tables).toEqual({ sales: { path: "s3://team-data/sales/" } });
  });

  it("declares two system tables", () => {
    const system = [
      { name: "queries", path: "/a/queries" },
      { name: "job_runs", path: "/a/job_runs" },
    ];
    const cfg = parse(kernelConfig(TEXT, { ...LOCAL, system }));
    expect(Object.keys((cfg.catalogs as { system: { tables: object } }).system.tables)).toEqual(["queries", "job_runs"]);
  });

  it("generates nothing for the system catalog when no table is published", () => {
    expect(kernelConfig(TEXT, { ...LOCAL, system: [] })).toBe(TEXT);
  });

  it("replaces a system catalog the stored text declares, and keeps the other catalogs", () => {
    const text = `${TEXT}\n[catalogs.system]\ndescription = "mine"\n\n[catalogs.system.tables.mine]\npath = "x"\n\n[catalogs.sales]\ndescription = "Sales"\n`;
    const cfg = parse(kernelConfig(text, { ...LOCAL, system: [{ name: "queries", path: "/q" }] }));
    expect(cfg.catalogs).toEqual({
      system: { description: "The Studio's own records (read-only)", tables: { queries: { path: "/q", format: "parquet" } } },
      sales: { description: "Sales" },
    });
  });
});
