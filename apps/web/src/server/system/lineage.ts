import fs from "node:fs";
import path from "node:path";

import { sourceOf } from "@/lib/system/lineageSource";
import type { LineageSource, LineageUse, QueryLogEntry, TableLineage } from "@/lib/system/types";

import { systemDir } from "./paths";

/** The index of `catalog.schema.table` names: the latest use by each source, as writer and as reader. */
interface Uses {
  writers: Map<string, LineageUse>;
  readers: Map<string, LineageUse>;
}

const SAVE_EVERY_MS = 5_000;

interface State {
  index: Map<string, Uses> | null;
  timer: NodeJS.Timeout | null;
  dirty: boolean;
}

// on globalThis, like the kernel manager: the code that logs runs and the action that reads them must share one index
const g = globalThis as { __iaraLineage?: State };
const state = (g.__iaraLineage ??= { index: null, timer: null, dirty: false });

const fileOf = () => path.join(systemDir(), "lineage.json");
const keyOf = (source: LineageSource) => `${source.kind}:${source.id}`;

function usesOf(tables: Map<string, Uses>, table: string): Uses {
  let uses = tables.get(table);
  if (!uses) tables.set(table, (uses = { writers: new Map(), readers: new Map() }));
  return uses;
}

/** The saved index; a missing or broken file is an empty one. */
function load(): Map<string, Uses> {
  if (state.index) return state.index;
  state.index = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(), "utf8")) as Record<string, Record<string, { writers: LineageUse[]; readers: LineageUse[] }>>;
    for (const [table, saved] of Object.entries(raw.tables)) {
      const uses = usesOf(state.index, table);
      for (const u of saved.writers) uses.writers.set(keyOf(u.source), u);
      for (const u of saved.readers) uses.readers.set(keyOf(u.source), u);
    }
  } catch (e) {
    state.index = new Map();
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error("lineage: the saved index is not read", e);
  }
  return state.index;
}

function changed(): void {
  state.dirty = true;
  if (state.timer) return;
  state.timer = setTimeout(save, SAVE_EVERY_MS);
  state.timer.unref();
}

function save(): void {
  state.timer = null;
  if (!state.dirty || !state.index) return;
  state.dirty = false;
  try {
    const tables = Object.fromEntries([...state.index].map(([table, u]) => [table, { writers: [...u.writers.values()], readers: [...u.readers.values()] }]));
    fs.mkdirSync(systemDir(), { recursive: true });
    const tmp = `${fileOf()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ tables }));
    fs.renameSync(tmp, fileOf());
  } catch (e) {
    console.error("lineage: the index is not saved", e);
  }
}

/** Records a run in the index: each table it read or wrote, under the run's source. Never throws. */
export function noteRun(entry: QueryLogEntry): void {
  try {
    const source = sourceOf(entry);
    if (!source) return;
    const tables = load();
    const read = [...new Set(entry.reads.map((r) => r.table).filter((t): t is string => t !== null))];
    const use = (version: number | null, inputs: string[]): LineageUse => ({ source, user: entry.user, ts: entry.ts, version, inputs });
    let touched = false;
    for (const r of entry.reads) {
      if (!r.table) continue;
      usesOf(tables, r.table).readers.set(keyOf(source), use(r.version, []));
      touched = true;
    }
    for (const w of entry.writes) {
      if (!w.table) continue;
      usesOf(tables, w.table).writers.set(keyOf(source), use(w.version, read.filter((t) => t !== w.table)));
      touched = true;
    }
    if (touched) changed();
  } catch (e) {
    console.error("lineage: a run is not noted", e);
  }
}

/** The writers and readers of a table (`catalog.schema.table`), newest first. */
export function lineageOf(table: string): TableLineage {
  const uses = load().get(table);
  const newest = (m: Map<string, LineageUse>) => [...m.values()].sort((a, b) => b.ts - a.ts);
  return { writers: uses ? newest(uses.writers) : [], readers: uses ? newest(uses.readers) : [] };
}
