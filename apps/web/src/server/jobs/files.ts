import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

import { jobToml, parseJob, type JobSpec } from "@/lib/jobs";
import { movedPath } from "@/lib/paths";

import { normalizeRelative } from "../kernel/keys";
import { exists, resolveWorkspacePath } from "../workspace/files";

/** Job definitions: `jobs/<id>.toml` files of the workspace (versioned with it). */

export const JOBS_DIR = "jobs";

export interface JobProblem {
  id: string;
  error: string;
}

function checkedId(id: string): string {
  if (!/^[a-z0-9_]{1,64}$/.test(id)) throw new Error(`invalid job id ${id}`);
  return id;
}

function fileOf(id: string): string {
  return resolveWorkspacePath(`${JOBS_DIR}/${checkedId(id)}.toml`);
}

export async function listJobs(): Promise<{ jobs: JobSpec[]; problems: JobProblem[] }> {
  let names: string[];
  try {
    names = await fs.readdir(resolveWorkspacePath(JOBS_DIR));
  } catch {
    return { jobs: [], problems: [] };
  }
  const jobs: JobSpec[] = [];
  const problems: JobProblem[] = [];
  for (const name of names.filter((n) => n.endsWith(".toml")).sort()) {
    const id = name.slice(0, -".toml".length);
    try {
      jobs.push(parseJob(checkedId(id), await fs.readFile(fileOf(id), "utf8")));
    } catch (e) {
      problems.push({ id, error: (e as Error).message });
    }
  }
  return { jobs, problems };
}

export async function readJob(id: string): Promise<JobSpec> {
  try {
    return parseJob(id, await fs.readFile(fileOf(id), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw Object.assign(new Error(`there is no job ${id}`), { type: "NotFound" });
    throw e;
  }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, file);
}

/** Write a job's file (its target must exist). */
export async function writeJob(spec: JobSpec): Promise<JobSpec> {
  for (const t of spec.tasks) {
    if (!(await exists(t.target))) throw new Error(`${t.target} does not exist`);
  }
  await writeAtomic(fileOf(spec.id), jobToml(spec));
  return spec;
}

/** A `target = "..."` line: its key part, and its quoted value. */
const TARGET_LINE = /^(\s*target\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*')/;
/** A table header: `[name]`, or `[[name]]` for a list of tables. */
const TABLE_HEADER = /^\s*(\[\[?)\s*([^\]]*?)\s*\]\]?/;

function decodedTarget(quoted: string): string | null {
  if (quoted.startsWith("'")) return quoted.slice(1, -1).trim();
  try {
    return (JSON.parse(quoted) as string).trim();
  } catch {
    return null;
  }
}

/**
 * A job's TOML with its task targets moved: `moves` maps each old target to
 * its new one. Only the target lines change (comments and other keys stay).
 * A `target` key of a `[params]` table is not a task's, so it is left alone.
 */
export function retargetTargets(toml: string, moves: ReadonlyMap<string, string>): string {
  const lines = toml.split("\n");
  // "top": the file's own keys (one task); "task": a [[task]] table; "other": any other table
  let scope: "top" | "task" | "other" = "top";
  for (let i = 0; i < lines.length; i++) {
    const header = TABLE_HEADER.exec(lines[i]);
    if (header) {
      scope = header[1] === "[[" && header[2] === "task" ? "task" : "other";
      continue;
    }
    if (scope === "other") continue;
    const line = TARGET_LINE.exec(lines[i]);
    if (!line) continue;
    const to = moves.get(decodedTarget(line[2]) ?? "");
    if (to !== undefined) lines[i] = lines[i].replace(TARGET_LINE, (_, key: string) => `${key}${JSON.stringify(to)}`);
  }
  // the first line is the comment the Studio writes for a one-task job: "# A Iara job: runs <target> ..."
  for (const [from, to] of moves) {
    const note = `# A Iara job: runs ${from}`;
    if (lines[0]?.startsWith(`${note} `)) lines[0] = `# A Iara job: runs ${to}${lines[0].slice(note.length)}`;
  }
  return lines.join("\n");
}

/** A job's TOML pointing at `to` instead of `from`: only the target changes (comments and other keys stay). */
export function retargetToml(toml: string, from: string, to: string): string {
  return retargetTargets(toml, new Map([[from, to]]));
}

/** A file or folder moved: the jobs that run it (or a file in it) follow, through every task. Returns the ids of the jobs changed. */
export async function retargetJobs(from: string, to: string): Promise<string[]> {
  const { jobs } = await listJobs();
  const changed: string[] = [];
  for (const job of jobs) {
    const moves = new Map<string, string>();
    for (const task of job.tasks) {
      let current: string;
      try {
        current = normalizeRelative(task.target);
      } catch {
        continue;
      }
      const next = movedPath(current, from, to);
      if (next !== null) moves.set(task.target, next);
    }
    if (!moves.size) continue;
    const file = fileOf(job.id);
    await writeAtomic(file, retargetTargets(await fs.readFile(file, "utf8"), moves));
    changed.push(job.id);
  }
  return changed;
}

/** An id for a new job, not taken yet. */
export async function freeJobId(base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}_${n}`;
    if (!(await exists(`${JOBS_DIR}/${id}.toml`))) return id;
  }
}

export async function deleteJob(id: string): Promise<void> {
  await fs.rm(fileOf(id), { force: true });
}
