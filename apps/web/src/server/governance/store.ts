import "server-only";

import fs from "node:fs";
import path from "node:path";

import type { StudioUser } from "../auth/access";
import { dataDir } from "../compute/store";
import { allowFor, checkedGrant, DEFAULT_GRANTS, type Grant } from "./grants";

/**
 * The grants, saved in the Studio's data folder as `grants.json`. A missing
 * file grants the defaults; a file that cannot be read throws, so a broken
 * file never widens what people may read.
 */

export function grantsFile(dir = dataDir()): string {
  return path.join(dir, "grants.json");
}

/** The saved grants (the defaults when none were saved). Throws on a bad file. */
export function readGrants(dir = dataDir()): Grant[] {
  const file = grantsFile(dir);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return DEFAULT_GRANTS;
    throw e;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  const grants = (data as { grants?: unknown } | null)?.grants;
  if (!Array.isArray(grants)) throw new Error(`${file} has no grants list`);
  return grants.map(checkedGrant);
}

/** Saves the grants; written to a temp file and renamed, so a reader never sees half a file. */
export function writeGrants(grants: Grant[], dir = dataDir()): void {
  const file = grantsFile(dir);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ grants: grants.map(checkedGrant) }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The tables the user's mediated queries may read (null: everything). */
export function userAllow(user: StudioUser): string[] | null {
  return allowFor(user, readGrants());
}
