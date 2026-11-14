import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

import { kernels } from "../kernel/manager";
import { writeAtomic } from "../workspace/atomic";
import { syncWorkspaceKernel } from "../workspace/catalogChanges";
import { dayOf, rowsFile, tableDir } from "./paths";
import { importLegacyHistory } from "./queryLog";
import { markPublished, publishedFiles, publishedUrl } from "./store";
import { TABLES, type SystemTable } from "./tables";

/**
 * Publishes the `system` catalog every minute: snapshot tables are rewritten
 * when their rows change, then each JSON lines file that changed since it was
 * last published is turned into Parquet by a kernel.
 */

const TICK_MS = 60_000;

/** The file's text, null when there is none. */
async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function logged(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`system catalog: ${what} failed: ${(e as Error).message}`);
  }
}

export class Publisher {
  private ticking = false;
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      importLegacyHistory();
      for (const table of TABLES) {
        const rows = table.rows;
        if (rows) await logged(`snapshot ${table.name}`, async () => writeSnapshot(table.name, await rows()));
      }
      for (const table of TABLES) await this.publishTable(table);
    } finally {
      this.ticking = false;
    }
  }

  private async publishTable(table: SystemTable): Promise<void> {
    await fs.mkdir(tableDir(table.name), { recursive: true });
    let names = (await fs.readdir(tableDir(table.name))).filter((n) => n.endsWith(".jsonl"));
    if (!names.length && !table.rows) {
      // a log nobody wrote to yet is published empty, so every table of the catalog exists after the first tick
      const today = `${dayOf(Date.now())}.jsonl`;
      await fs.writeFile(path.join(tableDir(table.name), today), "", { flag: "a" });
      names = [today];
    }
    for (const file of names) await logged(`publish ${table.name}/${file}`, () => this.publishFile(table, file));
  }

  private async publishFile(table: SystemTable, file: string): Promise<void> {
    const source = path.join(tableDir(table.name), file);
    const stat = await fs.stat(source);
    const key = `${table.name}/${file}`;
    const signature = `${stat.size}:${stat.mtimeMs}`;
    const published = await publishedFiles();
    if (published.get(key) === signature) return;
    const first = ![...published.keys()].some((k) => k.startsWith(`${table.name}/`));
    await kernels.system({ source, dest: publishedUrl(table.name, file.slice(0, -".jsonl".length)), columns: table.columns });
    await markPublished(key, signature);
    // the catalog just got this table: the SQL editor's kernel, if it runs, would not see it otherwise
    if (first) await syncWorkspaceKernel();
  }
}

/** Rewrites the snapshot file of a table when its rows differ from the file's text. */
async function writeSnapshot(table: string, rows: Record<string, unknown>[]): Promise<void> {
  const text = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
  const file = rowsFile(table, "snapshot");
  if ((await readText(file)) !== text) await writeAtomic(file, text);
}

const g = globalThis as { __iaraPublisher?: Publisher };

/** Started once per server (see instrumentation.ts). */
export function startPublisher(): Publisher {
  if (g.__iaraPublisher) return g.__iaraPublisher;
  const publisher = (g.__iaraPublisher = new Publisher());
  setInterval(() => void publisher.tick(), TICK_MS).unref();
  void publisher.tick();
  return publisher;
}
