import "server-only";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isFileId } from "@/features/workbench/fileIdRegistry";
import { isWithin, movedPath } from "@/lib/paths";

import { dataDir } from "../compute/store";
import { config } from "../config";

/**
 * Stable ids for notebooks and saved queries, used in URLs instead of their
 * path (which changes on rename). They live in the Studio's data
 * (`file-ids.json`), not in the files; a rename or move keeps a file's id.
 */

/** Where the index is kept (injected in tests). */
export interface IdFiles {
  read(): string | null;
  write(text: string): void;
}

/** id -> workspace-relative path, for one workspace */
type Index = Record<string, string>;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 8;

export function randomId(): string {
  let id = "";
  for (let i = 0; i < ID_LENGTH; i++) id += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return id;
}

export function diskIdFiles(file: string): IdFiles {
  return {
    read() {
      try {
        return fs.readFileSync(file, "utf8");
      } catch {
        return null;
      }
    },
    write(text) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
    },
  };
}

function textual(index: unknown): Index {
  const out: Index = {};
  if (typeof index !== "object" || index === null) return out;
  for (const [id, p] of Object.entries(index)) if (typeof p === "string") out[id] = p;
  return out;
}

export class FileIds {
  /**
   * Every call reads the file and (when something changed) writes it back
   * synchronously: readers never see a stale copy, even with several module
   * instances in one process.
   */
  constructor(
    private readonly root: string,
    private readonly files: IdFiles,
    private readonly random: () => string = randomId,
  ) {}

  private all(): Record<string, unknown> {
    try {
      const doc: unknown = JSON.parse(this.files.read() ?? "{}");
      return typeof doc === "object" && doc !== null ? (doc as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private load(): Index {
    return textual(this.all()[this.root]);
  }

  private save(index: Index): void {
    this.files.write(JSON.stringify({ ...this.all(), [this.root]: index }, null, 2));
  }

  /** The id of each path (new ids for paths without one). */
  idsFor(paths: string[]): Record<string, string> {
    const index = this.load();
    const byPath = new Map<string, string>();
    for (const [id, p] of Object.entries(index)) if (!byPath.has(p)) byPath.set(p, id);
    let added = false;
    for (const p of paths) {
      if (byPath.has(p)) continue;
      let id = this.random();
      while (id in index) id = this.random();
      index[id] = p;
      byPath.set(p, id);
      added = true;
    }
    if (added) this.save(index);
    return Object.fromEntries(paths.map((p) => [p, byPath.get(p) as string]));
  }

  /** The path an id names (null: unknown). */
  pathOf(id: string): string | null {
    return isFileId(id) ? (this.load()[id] ?? null) : null;
  }

  /** A file or folder moved: the ids of the files in it follow. */
  moved(from: string, to: string): void {
    const index = this.load();
    const next: Index = {};
    let changed = false;
    for (const [id, p] of Object.entries(index)) {
      const now = movedPath(p, from, to);
      // whatever was at the destination is gone (the move refuses to overwrite)
      if (now === null && isWithin(p, to)) {
        changed = true;
        continue;
      }
      next[id] = now ?? p;
      changed ||= now !== null;
    }
    if (changed) this.save(next);
  }

  /** A file or folder was deleted. */
  removed(rel: string): void {
    const index = this.load();
    const kept = Object.entries(index).filter(([, p]) => !isWithin(p, rel));
    if (kept.length !== Object.keys(index).length) this.save(Object.fromEntries(kept));
  }
}

let shared: FileIds | null = null;

function ids(): FileIds {
  shared ??= new FileIds(config.workspace, diskIdFiles(path.join(dataDir(), "file-ids.json")));
  return shared;
}

export const idsFor = (paths: string[]) => ids().idsFor(paths);
export const pathOf = (id: string) => ids().pathOf(id);

/** Keeping the index in step with a file operation must not fail the operation (which already happened). */
function bestEffort(what: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.error(`file ids: ${what} failed: ${(e as Error).message}`);
  }
}

export const moved = (from: string, to: string) => bestEffort("move", () => ids().moved(from, to));
export const removed = (rel: string) => bestEffort("removal", () => ids().removed(rel));
