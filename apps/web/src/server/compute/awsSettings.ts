import "server-only";

import fs from "node:fs";
import path from "node:path";

/**
 * AWS access of the Studio server (it creates and terminates clusters):
 * `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (/ `AWS_SESSION_TOKEN`), or
 * the same as `ACCESS_KEY` / `SECRET_KEY` in a dotenv file named by
 * `WORKHOUSE_AWS_ENV_FILE` (in development, the repository's `.aws`).
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
  const explicit = process.env.WORKHOUSE_AWS_ENV_FILE;
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
  const accessKeyId = pick("AWS_ACCESS_KEY_ID", "ACCESS_KEY");
  const secretAccessKey = pick("AWS_SECRET_ACCESS_KEY", "SECRET_KEY");
  if (!accessKeyId || !secretAccessKey) return null;
  const region = pick("WORKHOUSE_AWS_REGION", "AWS_REGION", "AWS_DEFAULT_REGION") ?? "us-east-1";
  return { region, credentials: { accessKeyId, secretAccessKey, sessionToken: pick("AWS_SESSION_TOKEN") } };
}

export { parseDotenv };
