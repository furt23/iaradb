import "server-only";

import fs from "node:fs";
import path from "node:path";

/**
 * AWS access of the Studio server (it creates and terminates clusters):
 * `IARA_AWS_ACCESS_KEY_ID` / `IARA_AWS_SECRET_ACCESS_KEY` when set (then
 * `AWS_*` can hold the R2 keys the kernels read), else `AWS_ACCESS_KEY_ID` /
 * `AWS_SECRET_ACCESS_KEY` (/ `AWS_SESSION_TOKEN`), or
 * the same as `ACCESS_KEY` / `SECRET_KEY` in a dotenv file named by
 * `IARA_AWS_ENV_FILE` (in development, the repository's `.aws`).
 * Values never leave the server and are never logged.
 */

export interface AwsSettings {
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
}

function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

function findUp(start: string, name: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const p = path.join(dir, name);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function envFile(): Record<string, string> {
  const explicit = process.env.IARA_AWS_ENV_FILE;
  const file = explicit ?? (process.env.NODE_ENV !== "production" ? findUp(process.cwd(), ".aws") : null);
  if (!file) return {};
  try {
    return parseDotenv(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** The settings, or null when no credentials are configured. */
export function awsSettings(): AwsSettings | null {
  const file = envFile();
  const pick = (...names: string[]) => names.map((n) => process.env[n] || file[n]).find((v) => v);
  // IARA_AWS_* first: AWS_* may hold another store's keys (R2) for the kernels
  const own = !!pick("IARA_AWS_ACCESS_KEY_ID");
  const accessKeyId = own ? pick("IARA_AWS_ACCESS_KEY_ID") : pick("AWS_ACCESS_KEY_ID", "ACCESS_KEY");
  const secretAccessKey = own ? pick("IARA_AWS_SECRET_ACCESS_KEY") : pick("AWS_SECRET_ACCESS_KEY", "SECRET_KEY");
  if (!accessKeyId || !secretAccessKey) return null;
  const region = (own ? pick("IARA_AWS_REGION") : pick("IARA_AWS_REGION", "AWS_REGION", "AWS_DEFAULT_REGION")) ?? "us-east-1";
  const sessionToken = own ? pick("IARA_AWS_SESSION_TOKEN") : pick("AWS_SESSION_TOKEN");
  return { region, credentials: { accessKeyId, secretAccessKey, sessionToken } };
}

export { parseDotenv };
