import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { joinQuery } from "@/features/queries/queryHeader";
import type { ChartWidget, LayoutItem, Recipe } from "@/lib/dashboards/types";

let workspace: string;
let data: string;
let store: typeof import("./store");
let publish: typeof import("./publish");

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "iara-ws-"));
  data = fs.mkdtempSync(path.join(os.tmpdir(), "iara-data-"));
  vi.stubEnv("IARA_WORKSPACE", workspace);
  vi.stubEnv("IARA_STUDIO_DATA", data);
  vi.resetModules(); // the workspace is read from the environment when the config loads
  store = await import("./store");
  publish = await import("./publish");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(data, { recursive: true, force: true });
});

const file = (...p: string[]) => path.join(workspace, "dashboards", ...p);
const chart: ChartWidget = { id: "chart001", kind: "chart", title: "Revenue", dataset: "sales", spec: { kind: "bar", x: "region", y: ["amount"], agg: "sum" } };
const item = (widget: string, y = 0): LayoutItem => ({ widget, x: 0, y, w: 6, h: 8 });
const recipe: Recipe = { source: { table: "main.sales" }, steps: [{ id: "s1", label: "Keep EU", enabled: true, op: { kind: "filter", column: "region", value: "EU" } }] };

describe("createDashboard", () => {
  it("makes a folder with a config and an empty layout, under a free name", async () => {
    const d = await store.createDashboard("Sales Overview!");
    expect(d.slug).toBe("sales_overview");
    expect(d.config).toMatchObject({ title: "Sales Overview!", refresh_minutes: 10 });
    expect(d.config.id).toMatch(/^[a-z0-9]{8}$/);
    expect(d).toMatchObject({ datasets: [], widgets: [], layout: [], problems: [] });
    expect(fs.readFileSync(file("sales_overview", "layout.json"), "utf8")).toBe("[]\n");
    expect((await store.createDashboard("Sales Overview")).slug).toBe("sales_overview_2");
    expect((await store.createDashboard("Sales Overview")).slug).toBe("sales_overview_3");
  });

  it("needs a title", async () => {
    await expect(store.createDashboard("  ")).rejects.toThrow(/title is missing/);
    expect(fs.existsSync(file())).toBe(false);
  });
});

describe("readDashboard", () => {
  it("is NotFound for a dashboard that is not there, and refuses names that escape", async () => {
    await expect(store.readDashboard("nope")).rejects.toMatchObject({ type: "NotFound" });
    await expect(store.readDashboard("../x")).rejects.toThrow(/invalid dashboard name/);
    await expect(store.deleteDashboard("../x")).rejects.toThrow(/invalid dashboard name/);
  });

  it("reads every file, and keeps the files it cannot read in problems", async () => {
    const { slug } = await store.createDashboard("Sales");
    await store.saveDataset(slug, "sales", joinQuery({ chart: null, params: { year: { type: "number", default: 2024 } }, body: "SELECT * FROM sales WHERE year = :year\n" }));
    await store.saveWidget(slug, chart);
    await store.saveWidget(slug, { id: "text0001", kind: "text", markdown: "# Hi\n" });
    await store.saveLayout(slug, [item("chart001"), item("text0001", 8)]);
    fs.writeFileSync(file(slug, "datasets", "Bad Name.sql"), "SELECT 1");
    fs.writeFileSync(file(slug, "widgets", "aaaaaaaa.json"), "{ nope");
    fs.writeFileSync(file(slug, "widgets", "short.md"), "x");
    const d = await store.readDashboard(slug);
    expect(d.datasets).toEqual([{ name: "sales", sql: "SELECT * FROM sales WHERE year = :year\n", params: { year: { type: "number", default: 2024 } } }]);
    expect(d.widgets).toEqual([chart, { id: "text0001", kind: "text", markdown: "# Hi\n" }]);
    expect(d.layout).toEqual([item("chart001"), item("text0001", 8)]);
    expect(d.problems.map((p) => p.file).sort()).toEqual(["datasets/Bad Name.sql", "widgets/aaaaaaaa.json", "widgets/short.md"]);
  });

  it("reads recipe datasets with the SQL ones, by name, and reports the recipes it cannot take", async () => {
    const { slug } = await store.createDashboard("Sales");
    await store.saveDataset(slug, "b_sql", "SELECT 1");
    await store.saveRecipe(slug, "a_recipe", recipe);
    await store.saveRecipe(slug, "c_recipe", recipe);
    fs.writeFileSync(file(slug, "datasets", "b_sql.recipe.json"), JSON.stringify(recipe));
    fs.writeFileSync(file(slug, "datasets", "broken.recipe.json"), '{"source":{"table":""},"steps":[]}');
    fs.writeFileSync(file(slug, "datasets", "Bad Name.recipe.json"), JSON.stringify(recipe));
    const d = await store.readDashboard(slug);
    expect(d.datasets).toEqual([
      { name: "a_recipe", sql: "", params: {}, recipe },
      { name: "b_sql", sql: "SELECT 1", params: {} },
      { name: "c_recipe", sql: "", params: {}, recipe },
    ]);
    expect(d.problems).toEqual([
      { file: "datasets/Bad Name.recipe.json", error: "invalid dataset name Bad Name" },
      { file: "datasets/b_sql.recipe.json", error: "there are two dataset files for b_sql" },
      { file: "datasets/broken.recipe.json", error: "source table is missing" },
    ]);
  });

  it("reads the mode of a SQL dataset from its header and of a recipe from its JSON, and reports any mode but live", async () => {
    const { slug } = await store.createDashboard("Sales");
    fs.mkdirSync(file(slug, "datasets"), { recursive: true });
    fs.writeFileSync(file(slug, "datasets", "a_live.sql"), "-- iara:mode live\nSELECT 1");
    fs.writeFileSync(file(slug, "datasets", "b_extract.sql"), "-- iara:mode extract\nSELECT 2");
    fs.writeFileSync(file(slug, "datasets", "c_none.sql"), "SELECT 3");
    fs.writeFileSync(file(slug, "datasets", "d_live.recipe.json"), JSON.stringify({ ...recipe, mode: "live" }));
    fs.writeFileSync(file(slug, "datasets", "e_bad.recipe.json"), JSON.stringify({ ...recipe, mode: "extract" }));
    fs.writeFileSync(file(slug, "datasets", "f_none.recipe.json"), JSON.stringify(recipe));
    const d = await store.readDashboard(slug);
    expect(d.datasets).toEqual([
      { name: "a_live", sql: "SELECT 1", params: {}, mode: "live" },
      { name: "c_none", sql: "SELECT 3", params: {} },
      { name: "d_live", sql: "", params: {}, recipe, mode: "live" },
      { name: "f_none", sql: "", params: {}, recipe },
    ]);
    expect(d.problems).toEqual([
      { file: "datasets/b_extract.sql", error: 'invalid mode "extract": only "live" can be set' },
      { file: "datasets/e_bad.recipe.json", error: 'invalid mode "extract": only "live" can be set' },
    ]);
  });

  it("reports a broken layout.json and loads the rest", async () => {
    const { slug } = await store.createDashboard("Sales");
    fs.writeFileSync(file(slug, "layout.json"), "[1]");
    const d = await store.readDashboard(slug);
    expect(d.layout).toEqual([]);
    expect(d.problems).toEqual([{ file: "layout.json", error: expect.stringContaining("layout item 1") }]);
  });

  it("takes a dashboard without a layout.json", async () => {
    const { slug } = await store.createDashboard("Sales");
    fs.rmSync(file(slug, "layout.json"));
    expect((await store.readDashboard(slug)).layout).toEqual([]);
  });
});

describe("saving", () => {
  it("keeps a dashboard's id when its config changes, and checks the rest", async () => {
    const d = await store.createDashboard("Sales");
    const saved = await store.saveConfig(d.slug, { ...d.config, title: "Sales 2", cluster: "c1", refresh_minutes: 30 });
    expect((await store.readDashboard(d.slug)).config).toEqual(saved);
    expect(saved).toEqual({ id: d.config.id, title: "Sales 2", cluster: "c1", refresh_minutes: 30 });
    await expect(store.saveConfig(d.slug, { ...d.config, id: "zzzzzzzz" })).rejects.toThrow(/cannot change/);
    await expect(store.saveConfig(d.slug, { ...d.config, refresh_minutes: 0 })).rejects.toThrow(/refresh_minutes/);
  });

  it("writes a dataset's file as given, and refuses a name or a size it should not take", async () => {
    const { slug } = await store.createDashboard("Sales");
    const saved = await store.saveDataset(slug, "sales", "SELECT 1");
    expect(saved).toEqual({ name: "sales", sql: "SELECT 1", params: {} });
    expect(fs.readFileSync(file(slug, "datasets", "sales.sql"), "utf8")).toBe("SELECT 1");
    await expect(store.saveDataset(slug, "../sales", "SELECT 1")).rejects.toThrow(/invalid dataset name/);
    await expect(store.saveDataset(slug, "Sales", "SELECT 1")).rejects.toThrow(/invalid dataset name/);
    await expect(store.saveDataset(slug, "big", "x".repeat((1 << 20) + 1))).rejects.toThrow(/1 MB/);
    await expect(store.saveDataset("ghost", "sales", "SELECT 1")).rejects.toMatchObject({ type: "NotFound" });
    expect(fs.existsSync(file("ghost"))).toBe(false);
    await store.deleteDataset(slug, "sales");
    expect(fs.existsSync(file(slug, "datasets", "sales.sql"))).toBe(false);
  });

  it("writes a recipe dataset's file, and refuses what is not a recipe, a name, or a name a SQL dataset has", async () => {
    const { slug } = await store.createDashboard("Sales");
    const saved = await store.saveRecipe(slug, "eu", { ...recipe, extra: 1 } as never);
    expect(saved).toEqual({ name: "eu", sql: "", params: {}, recipe });
    expect(JSON.parse(fs.readFileSync(file(slug, "datasets", "eu.recipe.json"), "utf8"))).toEqual(recipe);
    expect(fs.readFileSync(file(slug, "datasets", "eu.recipe.json"), "utf8").endsWith("}\n")).toBe(true);
    await expect(store.saveRecipe(slug, "../eu", recipe)).rejects.toThrow(/invalid dataset name/);
    await expect(store.saveRecipe(slug, "bad", { source: { table: "" }, steps: [] })).rejects.toThrow(/source table/);
    await expect(store.saveRecipe(slug, "bad", null as never)).rejects.toThrow(/a recipe is an object/);
    await expect(store.saveRecipe("ghost", "eu", recipe)).rejects.toMatchObject({ type: "NotFound" });
    await store.saveDataset(slug, "plain", "SELECT 1");
    await expect(store.saveRecipe(slug, "plain", recipe)).rejects.toThrow(/already a SQL dataset plain/);
    await expect(store.saveDataset(slug, "eu", "SELECT 1")).rejects.toThrow(/already a recipe dataset eu/);
    expect(fs.existsSync(file(slug, "datasets", "plain.recipe.json"))).toBe(false);
    expect(fs.existsSync(file(slug, "datasets", "eu.sql"))).toBe(false);
    await store.deleteDataset(slug, "eu");
    expect(fs.existsSync(file(slug, "datasets", "eu.recipe.json"))).toBe(false);
    expect((await store.readDashboard(slug)).datasets.map((d) => d.name)).toEqual(["plain"]);
  });

  it("keeps a dataset's mode when it is saved without one, and takes the one the text sets", async () => {
    const { slug } = await store.createDashboard("Sales");
    await store.saveDataset(slug, "sales", "-- iara:mode live\nSELECT 1");
    // what the editor sends has no mode line: the file's stays
    expect(await store.saveDataset(slug, "sales", "SELECT 2")).toEqual({ name: "sales", sql: "SELECT 2", params: {}, mode: "live" });
    expect(fs.readFileSync(file(slug, "datasets", "sales.sql"), "utf8")).toBe("-- iara:mode live\nSELECT 2");
    // a text with the line sets the mode as it says
    const text = "-- iara:mode live\nSELECT 3";
    expect(await store.saveDataset(slug, "sales", text)).toMatchObject({ mode: "live" });
    // other header lines stay as they were around it
    const header = joinQuery({ chart: null, params: { y: { type: "number" } }, body: "SELECT :y", extra: [{ at: 0, line: "-- iara:note hi" }] });
    await store.saveDataset(slug, "sales", header);
    expect(fs.readFileSync(file(slug, "datasets", "sales.sql"), "utf8")).toBe(`-- iara:mode live\n${header}`);
    // a dataset that was not live stays so
    expect(await store.saveDataset(slug, "other", "SELECT 1")).toEqual({ name: "other", sql: "SELECT 1", params: {} });
    expect(await store.saveDataset(slug, "other", "SELECT 2")).not.toHaveProperty("mode");
    await expect(store.saveDataset(slug, "bad", "-- iara:mode extract\nSELECT 1")).rejects.toThrow(/invalid mode/);
    expect(fs.existsSync(file(slug, "datasets", "bad.sql"))).toBe(false);
  });

  it("keeps a recipe's mode when its steps are saved", async () => {
    const { slug } = await store.createDashboard("Sales");
    await store.saveRecipe(slug, "eu", recipe);
    await store.saveDatasetMode(slug, "eu", "live");
    const saved = await store.saveRecipe(slug, "eu", { ...recipe, steps: [] });
    expect(saved).toEqual({ name: "eu", sql: "", params: {}, recipe: { ...recipe, steps: [] }, mode: "live" });
    expect(JSON.parse(fs.readFileSync(file(slug, "datasets", "eu.recipe.json"), "utf8"))).toEqual({ source: recipe.source, steps: [], mode: "live" });
  });

  describe("saveDatasetMode", () => {
    it("adds and removes the header line of a SQL dataset, leaving the rest of the file as it is", async () => {
      const { slug } = await store.createDashboard("Sales");
      const chartLine = `-- iara:chart ${JSON.stringify({ kind: "bar", x: "a", y: ["b"] })}`;
      const original = `${chartLine}\n-- iara:note hi\nSELECT a, b FROM t\n`;
      fs.mkdirSync(file(slug, "datasets"), { recursive: true });
      fs.writeFileSync(file(slug, "datasets", "sales.sql"), original);
      const live = await store.saveDatasetMode(slug, "sales", "live");
      expect(live).toEqual({ name: "sales", sql: "SELECT a, b FROM t\n", params: {}, mode: "live" });
      expect(fs.readFileSync(file(slug, "datasets", "sales.sql"), "utf8")).toBe(`-- iara:mode live\n${original}`);
      // twice is once
      await store.saveDatasetMode(slug, "sales", "live");
      expect(fs.readFileSync(file(slug, "datasets", "sales.sql"), "utf8")).toBe(`-- iara:mode live\n${original}`);
      const extract = await store.saveDatasetMode(slug, "sales", "extract");
      expect(extract).toEqual({ name: "sales", sql: "SELECT a, b FROM t\n", params: {} });
      expect(fs.readFileSync(file(slug, "datasets", "sales.sql"), "utf8")).toBe(original);
      expect((await store.readDashboard(slug)).datasets).toEqual([extract]);
    });

    it("sets and removes the mode of a recipe dataset, and refuses a dataset or a name that is not there", async () => {
      const { slug } = await store.createDashboard("Sales");
      await store.saveRecipe(slug, "eu", recipe);
      const live = await store.saveDatasetMode(slug, "eu", "live");
      expect(live).toEqual({ name: "eu", sql: "", params: {}, recipe, mode: "live" });
      expect(JSON.parse(fs.readFileSync(file(slug, "datasets", "eu.recipe.json"), "utf8"))).toEqual({ ...recipe, mode: "live" });
      expect((await store.readDashboard(slug)).datasets).toEqual([live]);
      expect(await store.saveDatasetMode(slug, "eu", "extract")).toEqual({ name: "eu", sql: "", params: {}, recipe });
      expect(JSON.parse(fs.readFileSync(file(slug, "datasets", "eu.recipe.json"), "utf8"))).toEqual(recipe);
      await expect(store.saveDatasetMode(slug, "ghost", "live")).rejects.toThrow(/no dataset ghost/);
      await expect(store.saveDatasetMode(slug, "../eu", "live")).rejects.toThrow(/invalid dataset name/);
      await expect(store.saveDatasetMode("nope", "eu", "live")).rejects.toMatchObject({ type: "NotFound" });
    });
  });

  it("writes a text widget as .md and the others as .json, never both", async () => {
    const { slug } = await store.createDashboard("Sales");
    await store.saveWidget(slug, { id: "aaaaaaaa", kind: "table", dataset: "sales" });
    expect(JSON.parse(fs.readFileSync(file(slug, "widgets", "aaaaaaaa.json"), "utf8"))).toEqual({ kind: "table", dataset: "sales" });
    await store.saveWidget(slug, { id: "aaaaaaaa", kind: "text", markdown: "hello" });
    expect(fs.readFileSync(file(slug, "widgets", "aaaaaaaa.md"), "utf8")).toBe("hello");
    expect(fs.existsSync(file(slug, "widgets", "aaaaaaaa.json"))).toBe(false);
    await store.saveWidget(slug, { id: "aaaaaaaa", kind: "table", dataset: "sales" });
    expect(fs.existsSync(file(slug, "widgets", "aaaaaaaa.md"))).toBe(false);
  });

  it("refuses a widget that is not valid", async () => {
    const { slug } = await store.createDashboard("Sales");
    await expect(store.saveWidget(slug, { id: "aaaaaaaa", kind: "chart", dataset: "s", spec: { kind: "radar" } } as never)).rejects.toThrow(/spec kind/);
    await expect(store.saveWidget(slug, { id: "../x", kind: "table", dataset: "s" })).rejects.toThrow(/invalid widget id/);
    expect(fs.existsSync(file(slug, "widgets"))).toBe(false);
  });

  it("drops a deleted widget from the layout", async () => {
    const { slug } = await store.createDashboard("Sales");
    await store.saveWidget(slug, chart);
    await store.saveLayout(slug, [item("chart001"), item("text0001", 8)]);
    await store.deleteWidget(slug, "chart001");
    expect(fs.existsSync(file(slug, "widgets", "chart001.json"))).toBe(false);
    expect((await store.readDashboard(slug)).layout).toEqual([item("text0001", 8)]);
    await expect(store.deleteWidget(slug, "../layout")).rejects.toThrow(/invalid widget id/);
  });

  it("checks a layout before writing it", async () => {
    const { slug } = await store.createDashboard("Sales");
    await expect(store.saveLayout(slug, [{ ...item("chart001"), w: 13 }])).rejects.toThrow(/x and w/);
    expect(await store.saveLayout(slug, [item("chart001"), item("chart001", 8)])).toEqual([item("chart001")]);
  });
});

describe("listDashboards", () => {
  it("lists the dashboards with when they were published, and the folders that are not dashboards", async () => {
    expect(await store.listDashboards()).toEqual({ dashboards: [], problems: [] });
    const a = await store.createDashboard("Alpha");
    await store.createDashboard("Beta");
    fs.mkdirSync(file("stray"));
    fs.writeFileSync(file("loose.txt"), "x");
    publish.publishDashboard(await store.readDashboard(a.slug), { kind: "team" }, "me");
    const { dashboards, problems } = await store.listDashboards();
    expect(dashboards.map((d) => [d.slug, d.title, d.publishedAt !== null])).toEqual([
      ["alpha", "Alpha", true],
      ["beta", "Beta", false],
    ]);
    expect(dashboards[0].updatedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(problems).toEqual([{ slug: "stray", error: "there is no dashboard stray" }]);
  });
});

describe("deleteDashboard", () => {
  it("removes the folder and the published copy", async () => {
    const d = await store.createDashboard("Sales");
    publish.publishDashboard(d, { kind: "team" }, "me");
    expect(publish.getPublished(d.config.id)).not.toBeNull();
    expect(await store.deleteDashboard(d.slug)).toBe(d.config.id);
    expect(fs.existsSync(file(d.slug))).toBe(false);
    expect(publish.getPublished(d.config.id)).toBeNull();
    expect(await store.deleteDashboard(d.slug)).toBeNull();
  });
});
