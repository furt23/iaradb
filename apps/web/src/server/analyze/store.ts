import "server-only";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { QueryAnalysis } from "@workhouse/protocol";

import { preview } from "@/features/analyze/preview";
import type { AnalysisSummary, StoredAnalysis } from "@/features/analyze/types";

import { dataDir } from "../compute/store";

/**
 * Analyses in the Studio's data folder (not the workspace's): one JSON file
 * per analysis, the newest `KEEP` kept.
 */

export const KEEP = 100;
const ID = /^[a-z0-9]{8}$/;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function analysisDir(): string {
  return path.join(dataDir(), "analyses");
}

function fileOf(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
  fs.renameSync(`${file}.tmp`, file);
}

function newId(dir: string): string {
  for (;;) {
    const id = Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join("");
    if (!fs.existsSync(fileOf(dir, id))) return id;
  }
}

/** The ids of the stored analyses in `dir` (by file name only). */
function idsIn(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json") && ID.test(name.slice(0, -".json".length)))
      .map((name) => name.slice(0, -".json".length));
  } catch {
    return [];
  }
}

/** Every stored analysis, newest first (unreadable files are skipped). */
function readAll(dir: string): StoredAnalysis[] {
  const out: StoredAnalysis[] = [];
  for (const id of idsIn(dir)) {
    try {
      out.push(JSON.parse(fs.readFileSync(fileOf(dir, id), "utf8")) as StoredAnalysis);
    } catch {
      // a file cut short by a crash: left out of the list
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

export function summarize(a: StoredAnalysis): AnalysisSummary {
  return { id: a.id, preview: preview(a.query), at: a.at, elapsed_ms: a.profile.elapsed_ms, rows: a.rows };
}

export function listAnalyses(dir = analysisDir()): AnalysisSummary[] {
  return readAll(dir).map(summarize);
}

/** The analysis under `id` (null: none, or not an id). */
export function getAnalysis(id: string, dir = analysisDir()): StoredAnalysis | null {
  if (!ID.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(fileOf(dir, id), "utf8")) as StoredAnalysis;
  } catch {
    return null;
  }
}

/** Forgets the analyses beyond the newest `keep` (reads them only when there are too many). */
function prune(dir: string, keep: number): void {
  if (idsIn(dir).length <= keep) return;
  for (const old of readAll(dir).slice(keep)) fs.rmSync(fileOf(dir, old.id), { force: true });
}

/** Keeps a new analysis, and forgets the ones beyond the newest `keep`. */
export function saveAnalysis(analysis: QueryAnalysis, dir = analysisDir(), keep = KEEP): StoredAnalysis {
  fs.mkdirSync(dir, { recursive: true });
  const stored: StoredAnalysis = { ...analysis, id: newId(dir) };
  writeJson(fileOf(dir, stored.id), stored);
  prune(dir, keep);
  return stored;
}
