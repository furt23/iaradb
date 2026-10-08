import "server-only";

import fs from "node:fs";
import path from "node:path";

/**
 * Studio configuration, from the environment set by `workhouse serve`:
 *
 * - `WORKHOUSE_WORKSPACE`: workspace root (default: the repository's example workspace)
 * - `WORKHOUSE_PYTHON`: Python interpreter with `workhouse` installed
 *   (default: the repository's `.venv`, else `python` on PATH)
 */
export interface StudioConfig {
  workspace: string;
  python: string;
  /** minutes a kernel may stay unused before it is shut down */
  idleMinutes: number;
}

function findUp(start: string, marker: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, marker))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function defaultPython(repo: string | null): string {
  if (repo) {
    for (const rel of [".venv/Scripts/python.exe", ".venv/bin/python"]) {
      const p = path.join(repo, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return process.platform === "win32" ? "python" : "python3";
}

function loadConfig(): StudioConfig {
  const repo = findUp(process.cwd(), "pyproject.toml");
  const example = repo ? path.join(repo, "examples", "workspace") : null;
  const workspace = process.env.WORKHOUSE_WORKSPACE || (example && fs.existsSync(example) ? example : process.cwd());
  return {
    workspace: path.resolve(workspace),
    python: process.env.WORKHOUSE_PYTHON || defaultPython(repo),
    idleMinutes: Number(process.env.WORKHOUSE_KERNEL_IDLE_MINUTES || 60),
  };
}

export const config: StudioConfig = loadConfig();
