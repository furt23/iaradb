/**
 * Rules for the Git remote settings (pure: the Studio's forms check the same
 * rules the server enforces, so this file has no server-only imports).
 */

export const DEFAULT_BRANCH = "main";

/** An https URL without embedded credentials (the token is stored separately). */
export function checkRemoteUrl(raw: string): string {
  const url = raw.trim();
  if (!url) throw new Error("the repository URL is required");
  if (/\s/.test(url)) throw new Error("the repository URL must not contain spaces");
  if (!/^https:\/\//i.test(url)) throw new Error("the repository URL must start with https:// (ssh, git and file remotes are not supported)");
  // any '@' before the first path separator is a credential (user, user:pass, or an empty pair)
  if (/^https:\/\/[^/]*@/i.test(url)) throw new Error("the repository URL must not contain credentials: enter the token in the token field");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("the repository URL is not valid");
  }
  if (!parsed.hostname) throw new Error("the repository URL has no host");
  return url;
}

/** A branch name that is safe to pass to git as a ref. */
export function checkBranch(raw: string): string {
  const branch = raw.trim();
  if (!branch) throw new Error("the branch is required");
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-")) {
    throw new Error(`invalid branch "${branch}": use letters, digits and . _ / -, not starting with -`);
  }
  const segments = branch.split("/");
  const badSegment = segments.some((s) => !s || s.startsWith(".") || s.endsWith(".") || s.endsWith(".lock"));
  if (branch.includes("..") || badSegment) throw new Error(`invalid branch "${branch}"`);
  return branch;
}

/**
 * A personal access token. Whitespace, quotes and '%' are refused: the token
 * reaches git through a helper script, and those characters would break it.
 */
export function checkToken(raw: string): string {
  const token = raw.trim();
  if (/[\s"%\x00-\x1f]/.test(token)) throw new Error("the token contains characters that are not allowed");
  return token;
}

/** Replace each secret in a text (error messages, output) with `***`. */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join("***");
  return out;
}

/** The URL without any user or password, for display. */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url.replace(/^(\w+:\/\/)[^/]*@/, "$1");
  }
}
