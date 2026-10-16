import { pipSpecError } from "@/lib/pipSpec";

import { ClusterError } from "./clusterError";
import { MAX_HOURS } from "./instanceTypes";

/** Validators of the free-form settings of a cluster (pure; they throw `InvalidCluster`). */

export const MAX_LIBRARIES = 50;
export const MAX_ENV = 50;
export const MAX_TAGS = 40;
export const MAX_INIT_BYTES = 8192;

/** Characters a library spec may use, since it is written into the boot script (single-quoted). `pipSpecError` checks the grammar. */
export const LIBRARY_SPEC = /^[A-Za-z0-9][A-Za-z0-9._\-[\],<>=!~+* ]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENV = new Set(["PATH", "HOME", "PYTHONUNBUFFERED", "PYTHONIOENCODING"]);

function invalid(message: string): never {
  throw new ClusterError("InvalidCluster", message);
}

export function checkedLibraries(libraries: string[]): string[] {
  if (!Array.isArray(libraries)) invalid("libraries must be a list");
  if (libraries.length > MAX_LIBRARIES) invalid(`at most ${MAX_LIBRARIES} libraries`);
  const seen = new Set<string>();
  return libraries.map((raw) => {
    const spec = String(raw).trim();
    const error = pipSpecError(spec) ?? (LIBRARY_SPEC.test(spec) ? null : "contains characters a boot script cannot take");
    if (error) invalid(`library "${spec}": ${error}`);
    const key = spec.toLowerCase();
    if (seen.has(key)) invalid(`library ${spec} is listed twice`);
    seen.add(key);
    return spec;
  });
}

export function checkedEnv(env: Record<string, string>): Record<string, string> {
  const entries = Object.entries(env ?? {});
  if (entries.length > MAX_ENV) invalid(`at most ${MAX_ENV} environment variables`);
  for (const [name, value] of entries) {
    if (!ENV_NAME.test(name)) invalid(`invalid variable name ${JSON.stringify(name.slice(0, 60))}: letters, digits and _, not starting with a digit`);
    if (name.startsWith("IARA_") || name.startsWith("AWS_") || RESERVED_ENV.has(name)) invalid(`${name} is reserved`);
    if (typeof value !== "string" || value.length > 4096) invalid(`the value of ${name} is longer than 4096 characters`);
    if (value.includes("\0")) invalid(`the value of ${name} has a NUL character`);
  }
  return Object.fromEntries(entries);
}

export function checkedInitScript(script: string): string {
  if (typeof script !== "string") invalid("the init script must be text");
  if (Buffer.byteLength(script, "utf8") > MAX_INIT_BYTES) invalid(`the init script is longer than ${MAX_INIT_BYTES} bytes`);
  if (script.includes("\0")) invalid("the init script has a NUL character");
  return script;
}

export function checkedMaxHours(hours: number): number {
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS) invalid(`the time limit must be a whole number of hours between 1 and ${MAX_HOURS}`);
  return hours;
}

export function checkedTags(tags: Record<string, string>): Record<string, string> {
  const entries = Object.entries(tags ?? {});
  if (entries.length > MAX_TAGS) invalid(`at most ${MAX_TAGS} tags`);
  for (const [key, value] of entries) {
    if (key.length < 1 || key.length > 128) invalid("tag keys are 1-128 characters");
    const lower = key.toLowerCase();
    if (lower.startsWith("aws:") || lower.startsWith("iara:") || key === "Name") invalid(`the tag key ${key} is reserved`);
    if (typeof value !== "string" || value.length > 256) invalid(`the value of tag ${key} is longer than 256 characters`);
  }
  return Object.fromEntries(entries);
}
