/**
 * The environment of a local kernel (pure; unit tested): an allowlist, not the
 * Studio's own environment, which holds its secrets (Auth0, the cluster AWS
 * account, the allowed emails, ...). User code runs in the kernel and can read
 * whatever the process was given.
 */

const ALLOWED = new Set([
  // the process and its Python
  "PATH",
  "HOME",
  "USERPROFILE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
  "VIRTUAL_ENV",
  "PYTHONPATH",
  // the team bucket's keys and region, for the engine's object store
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  // engine settings
  "IARA_SPILL_DIR",
  "IARA_MEMORY_LIMIT",
  "IARA_WORKSPACE",
]);

/** What a local kernel gets from `env` (Windows names are case-insensitive: `Path` is `PATH`). */
export function localKernelEnv(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (ALLOWED.has(platform === "win32" ? name.toUpperCase() : name)) out[name] = value;
  }
  out.PYTHONUNBUFFERED = "1";
  out.PYTHONIOENCODING = "utf-8";
  return out as NodeJS.ProcessEnv; // Next's typings make NODE_ENV required there; the kernel has no use for it
}
