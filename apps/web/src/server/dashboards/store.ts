import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

import { joinQuery, splitQuery } from "@/features/queries/queryHeader";
import { configToml, ID, parseConfig, randomId } from "@/lib/dashboards/config";
import { checkLayout, layoutJson, parseLayout } from "@/lib/dashboards/layout";
import { DATASET_NAME } from "@/lib/dashboards/query";
import { checkRecipe, parseRecipe, recipeJson } from "@/lib/dashboards/recipe";
import type { Dashboard, DashboardConfig, DashboardSummary, Dataset, LayoutItem, Recipe, Widget } from "@/lib/dashboards/types";
import { checkWidget, parseWidget, textWidget, widgetJson } from "@/lib/dashboards/widgets";
import { jobId } from "@/lib/jobs";

import { exists, resolveWorkspacePath } from "../workspace/files";
import { publishedAt, unpublish } from "./publish";

/**
 * Dashboards: `dashboards/<slug>/` folders of the workspace (versioned with
 * it), one file per domain: `dashboard.toml`, `datasets/<name>.sql|recipe.json`,
 * `widgets/<id>.json|md`, `layout.json`. Published copies are in publish.ts.
 */

export const DASHBOARDS_DIR = "dashboards";
const RECIPE_EXT = ".recipe.json";
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_FILE_BYTES = 1 << 20;
const MODE_LINE = /^-- iara:mode (.*)$/;

export interface DashboardProblem {
  slug: string;
  error: string;
}

function notFound(slug: string): Error {
  return Object.assign(new Error(`there is no dashboard ${slug}`), { type: "NotFound" });
}

function checkedSlug(slug: string): string {
  if (!SLUG.test(slug)) throw new Error(`invalid dashboard name ${slug}`);
  return slug;
}

/** A path inside a dashboard's folder (`rel`: "" for the folder). */
function pathIn(slug: string, rel: string): string {
  return resolveWorkspacePath(`${DASHBOARDS_DIR}/${checkedSlug(slug)}${rel ? `/${rel}` : ""}`);
}

async function writeAtomic(file: string, text: string): Promise<void> {
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) throw new Error("a dashboard file is limited to 1 MB");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, file);
}

/** Text of a file, or null when it is not there. */
async function readOptional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** The names in a folder of the dashboard that end in `ext` (none: the folder is not there). */
async function namesIn(slug: string, folder: string, ext: string): Promise<string[]> {
  try {
    return (await fs.readdir(pathIn(slug, folder))).filter((n) => n.endsWith(ext)).sort();
  } catch {
    return [];
  }
}

/** The newest modification among a folder and what is in it. */
async function newest(dir: string): Promise<number> {
  let t = (await fs.stat(dir)).mtimeMs;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? await newest(p) : (await fs.stat(p)).mtimeMs);
  }
  return t;
}

export async function readConfig(slug: string): Promise<DashboardConfig> {
  const text = await readOptional(pathIn(slug, "dashboard.toml"));
  if (text === null) throw notFound(slug);
  return parseConfig(text);
}

export async function listDashboards(): Promise<{ dashboards: DashboardSummary[]; problems: DashboardProblem[] }> {
  let entries;
  try {
    entries = await fs.readdir(resolveWorkspacePath(DASHBOARDS_DIR), { withFileTypes: true });
  } catch {
    return { dashboards: [], problems: [] };
  }
  const dashboards: DashboardSummary[] = [];
  const problems: DashboardProblem[] = [];
  for (const slug of entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    try {
      const { id, title, description } = await readConfig(slug);
      dashboards.push({ slug, id, title, ...(description && { description }), updatedAt: await newest(pathIn(slug, "")), publishedAt: publishedAt(id) });
    } catch (e) {
      problems.push({ slug, error: (e as Error).message });
    }
  }
  return { dashboards, problems };
}

/** The config of every dashboard whose `dashboard.toml` reads (the others are left out). */
export async function listConfigs(): Promise<{ slug: string; config: DashboardConfig }[]> {
  let entries;
  try {
    entries = await fs.readdir(resolveWorkspacePath(DASHBOARDS_DIR), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { slug: string; config: DashboardConfig }[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !SLUG.test(e.name)) continue;
    try {
      out.push({ slug: e.name, config: await readConfig(e.name) });
    } catch {
      // listDashboards reports it
    }
  }
  return out;
}

/** The values of the `-- iara:mode` header lines of a dataset's file. */
function modeLines(text: string): string[] {
  return splitQuery(text).extra.flatMap(({ line }) => {
    const m = MODE_LINE.exec(line);
    return m ? [m[1].trim()] : [];
  });
}

/** The mode a dataset's file sets: "live", or none (any other value is an error). */
function checkedMode(values: unknown[]): "live" | undefined {
  for (const v of values) if (v !== "live") throw new Error(`invalid mode ${JSON.stringify(v)}: only "live" can be set`);
  return values.length ? "live" : undefined;
}

/** A dataset from its file: the query without its header, and the header's placeholders and mode. */
function datasetOf(name: string, text: string): Dataset {
  if (!DATASET_NAME.test(name)) throw new Error(`invalid dataset name ${name}`);
  const { body, params } = splitQuery(text);
  const mode = checkedMode(modeLines(text));
  return { name, sql: body, params: params ?? {}, ...(mode && { mode }) };
}

/** A recipe dataset: its SQL is what the kernel compiles the recipe to, when it runs. */
function recipeDatasetOf(name: string, recipe: Recipe, mode?: "live"): Dataset {
  if (!DATASET_NAME.test(name)) throw new Error(`invalid dataset name ${name}`);
  return { name, sql: "", params: {}, recipe, ...(mode && { mode }) };
}

/** The `"mode"` of a recipe file, which checkRecipe leaves out. */
function recipeMode(text: string): "live" | undefined {
  const { mode } = JSON.parse(text) as { mode?: unknown };
  return checkedMode(mode === undefined ? [] : [mode]);
}

/** A recipe file's text; the mode sits beside source and steps. */
function recipeText(r: Recipe, mode?: "live"): string {
  return mode ? `${JSON.stringify({ source: r.source, steps: r.steps, mode }, null, 2)}\n` : recipeJson(r);
}

/** The file text with its `-- iara:mode live` line set or removed, the rest as it was. */
function withMode(text: string, mode: "extract" | "live"): string {
  const parts = splitQuery(text);
  const rest = parts.extra.filter((e) => !MODE_LINE.test(e.line));
  // the others move down one, so the known lines keep their places among them
  const extra = mode === "live" ? [{ at: 0, line: "-- iara:mode live" }, ...rest.map((e) => ({ ...e, at: e.at + 1 }))] : rest;
  return joinQuery({ ...parts, extra });
}

/** The dashboard in `dashboards/<slug>/`; a file that cannot be read is in `problems`, the rest loads. */
export async function readDashboard(slug: string): Promise<Dashboard> {
  const config = await readConfig(slug);
  const problems: Dashboard["problems"] = [];
  const attempt = async <T>(file: string, read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch (e) {
      problems.push({ file, error: (e as Error).message });
      return null;
    }
  };
  const read = (rel: string) => fs.readFile(pathIn(slug, rel), "utf8");

  const datasets: Dataset[] = [];
  for (const n of await namesIn(slug, "datasets", ".sql")) {
    const d = await attempt(`datasets/${n}`, async () => datasetOf(n.slice(0, -".sql".length), await read(`datasets/${n}`)));
    if (d) datasets.push(d);
  }
  for (const n of await namesIn(slug, "datasets", RECIPE_EXT)) {
    const name = n.slice(0, -RECIPE_EXT.length);
    const d = await attempt(`datasets/${n}`, async () => {
      if (datasets.some((x) => x.name === name)) throw new Error(`there are two dataset files for ${name}`);
      const text = await read(`datasets/${n}`);
      return recipeDatasetOf(name, parseRecipe(text), recipeMode(text));
    });
    if (d) datasets.push(d);
  }
  datasets.sort((a, b) => (a.name < b.name ? -1 : 1));

  const widgets: Widget[] = [];
  const names = [...(await namesIn(slug, "widgets", ".json")), ...(await namesIn(slug, "widgets", ".md"))].sort();
  for (const n of names) {
    const id = n.slice(0, n.lastIndexOf("."));
    const w = await attempt(`widgets/${n}`, async () => {
      if (widgets.some((x) => x.id === id)) throw new Error(`there are two widget files for ${id}`);
      return n.endsWith(".md") ? textWidget(checkedWidgetId(id), await read(`widgets/${n}`)) : parseWidget(id, await read(`widgets/${n}`));
    });
    if (w) widgets.push(w);
  }

  const layout = (await attempt("layout.json", async () => parseLayout((await readOptional(pathIn(slug, "layout.json"))) ?? "[]"))) ?? [];
  return { slug, config, datasets, widgets, layout, problems };
}

/** A widget id that names a file (throws when it is not an id). */
function checkedWidgetId(id: string): string {
  if (!ID.test(id)) throw new Error(`invalid widget id ${id}`);
  return id;
}

/** A folder name for a new dashboard that nothing uses yet. */
async function freeSlug(title: string): Promise<string> {
  const base = jobId(title).slice(0, 56);
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}_${n}`;
    if (!(await exists(`${DASHBOARDS_DIR}/${slug}`))) return slug;
  }
}

/** Start a dashboard: its folder holds a config and an empty layout. */
export async function createDashboard(title: string): Promise<Dashboard> {
  const slug = await freeSlug(title);
  const config = parseConfig(configToml({ id: randomId(), title, refresh_minutes: 10 }));
  await writeAtomic(pathIn(slug, "dashboard.toml"), configToml(config));
  await writeAtomic(pathIn(slug, "layout.json"), layoutJson([]));
  return readDashboard(slug);
}

/** Change a dashboard's title, description, cluster or refresh time (its id stays). */
export async function saveConfig(slug: string, config: DashboardConfig): Promise<DashboardConfig> {
  const current = await readConfig(slug);
  if (config.id !== current.id) throw new Error("the id of a dashboard cannot change");
  const next = parseConfig(configToml({ ...config, id: current.id }));
  await writeAtomic(pathIn(slug, "dashboard.toml"), configToml(next));
  return next;
}

/**
 * Write a dataset's file (`text`: the whole file, with its header). A text with
 * no `-- iara:mode` line keeps the mode the file has: callers that edit the
 * query know nothing of it.
 */
export async function saveDataset(slug: string, name: string, text: string): Promise<Dataset> {
  datasetOf(name, text);
  await readConfig(slug);
  if (await exists(`${DASHBOARDS_DIR}/${slug}/datasets/${name}${RECIPE_EXT}`)) throw new Error(`there is already a recipe dataset ${name}`);
  const file = pathIn(slug, `datasets/${name}.sql`);
  const keep = !modeLines(text).length && modeLines((await readOptional(file)) ?? "").includes("live");
  const full = keep ? withMode(text, "live") : text;
  await writeAtomic(file, full);
  return datasetOf(name, full);
}

/** Write a recipe dataset's file (the SQL is compiled by the kernel when the dataset runs); the file's mode stays. */
export async function saveRecipe(slug: string, name: string, recipe: Recipe): Promise<Dataset> {
  const r = checkRecipe(recipe);
  const dataset = recipeDatasetOf(name, r);
  await readConfig(slug);
  if (await exists(`${DASHBOARDS_DIR}/${slug}/datasets/${name}.sql`)) throw new Error(`there is already a SQL dataset ${name}`);
  const file = pathIn(slug, `datasets/${name}${RECIPE_EXT}`);
  const current = await readOptional(file);
  let mode: "live" | undefined;
  try {
    mode = current === null ? undefined : recipeMode(current);
  } catch {
    // a file that cannot be read has no mode to keep
  }
  await writeAtomic(file, recipeText(r, mode));
  return { ...dataset, ...(mode && { mode }) };
}

/** Set a dataset's mode in its file: "live" writes the header line (or the recipe's `"mode"`), "extract" removes it. */
export async function saveDatasetMode(slug: string, name: string, mode: "extract" | "live"): Promise<Dataset> {
  if (!DATASET_NAME.test(name)) throw new Error(`invalid dataset name ${name}`);
  await readConfig(slug);
  const sqlFile = pathIn(slug, `datasets/${name}.sql`);
  const sql = await readOptional(sqlFile);
  if (sql !== null) {
    const text = withMode(sql, mode);
    await writeAtomic(sqlFile, text);
    return datasetOf(name, text);
  }
  const recipeFile = pathIn(slug, `datasets/${name}${RECIPE_EXT}`);
  const json = await readOptional(recipeFile);
  if (json === null) throw new Error(`there is no dataset ${name}`);
  const recipe = parseRecipe(json);
  const file = JSON.parse(json) as Record<string, unknown>;
  delete file.mode;
  if (mode === "live") file.mode = "live";
  await writeAtomic(recipeFile, `${JSON.stringify(file, null, 2)}\n`);
  return recipeDatasetOf(name, recipe, mode === "live" ? "live" : undefined);
}

export async function deleteDataset(slug: string, name: string): Promise<void> {
  if (!DATASET_NAME.test(name)) throw new Error(`invalid dataset name ${name}`);
  await fs.rm(pathIn(slug, `datasets/${name}.sql`), { force: true });
  await fs.rm(pathIn(slug, `datasets/${name}${RECIPE_EXT}`), { force: true });
}

/** Write a widget: a text widget as `.md`, the others as `.json`. */
export async function saveWidget(slug: string, widget: Widget): Promise<Widget> {
  const w = checkWidget(widget.id, widget);
  await readConfig(slug);
  const [keep, drop] = w.kind === "text" ? ["md", "json"] : ["json", "md"];
  await writeAtomic(pathIn(slug, `widgets/${w.id}.${keep}`), w.kind === "text" ? w.markdown : widgetJson(w));
  await fs.rm(pathIn(slug, `widgets/${w.id}.${drop}`), { force: true });
  return w;
}

/** Remove a widget, and its place in the layout. */
export async function deleteWidget(slug: string, id: string): Promise<void> {
  checkedWidgetId(id);
  await fs.rm(pathIn(slug, `widgets/${id}.json`), { force: true });
  await fs.rm(pathIn(slug, `widgets/${id}.md`), { force: true });
  const text = await readOptional(pathIn(slug, "layout.json"));
  if (text === null) return;
  const layout = parseLayout(text);
  if (layout.some((i) => i.widget === id)) await writeAtomic(pathIn(slug, "layout.json"), layoutJson(layout.filter((i) => i.widget !== id)));
}

export async function saveLayout(slug: string, items: LayoutItem[]): Promise<LayoutItem[]> {
  const layout = checkLayout(items);
  await readConfig(slug);
  await writeAtomic(pathIn(slug, "layout.json"), layoutJson(layout));
  return layout;
}

/** Remove a dashboard's folder and its published copy. Returns its id (null: its config could not be read). */
export async function deleteDashboard(slug: string): Promise<string | null> {
  const id = await readConfig(slug).then(
    (c) => c.id,
    () => null,
  );
  await fs.rm(pathIn(slug, ""), { recursive: true, force: true });
  if (id) unpublish(id);
  return id;
}
