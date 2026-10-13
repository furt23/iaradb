import "server-only";

import fs from "node:fs";
import path from "node:path";

import { dataDir } from "../compute/store";
import { checkBranch, checkRemoteUrl, checkToken } from "./validate";

/**
 * The team's Git remote: url and branch, plus a personal access token, in
 * `<dataDir>/git-remote.json` (mode 0600). The token never leaves the server:
 * settings returned to the client say only whether one is stored.
 */

export interface RemoteSettings {
  url: string;
  branch: string;
  hasToken: boolean;
}

/** What one git child process needs to authenticate; the token is only in `env`. */
export interface GitAuth {
  env: Record<string, string>;
  secrets: string[];
}

interface Stored {
  url: string;
  branch: string;
  token?: string;
}

const FILE = "git-remote.json";

function readStored(dir: string): Stored | null {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, FILE), "utf8")) as Partial<Stored>;
    if (typeof data.url !== "string" || typeof data.branch !== "string") return null;
    return { url: data.url, branch: data.branch, token: typeof data.token === "string" && data.token ? data.token : undefined };
  } catch {
    return null;
  }
}

function writeStored(dir: string, stored: Stored): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stored, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The saved remote, or null when none is connected. */
export function remoteSettings(dir: string = dataDir()): RemoteSettings | null {
  const stored = readStored(dir);
  return stored ? { url: stored.url, branch: stored.branch, hasToken: stored.token !== undefined } : null;
}

/**
 * Validate and save the url and branch. An empty token keeps the stored one;
 * a new token replaces it.
 */
export function saveRemote(input: { url: string; branch: string; token?: string }, dir: string = dataDir()): RemoteSettings {
  const url = checkRemoteUrl(input.url);
  const branch = checkBranch(input.branch);
  const newToken = input.token?.trim() ? checkToken(input.token) : undefined;
  const token = newToken ?? readStored(dir)?.token;
  writeStored(dir, { url, branch, token });
  return { url, branch, hasToken: token !== undefined };
}

/** Forget the stored token; the url and branch stay. */
export function clearToken(dir: string = dataDir()): void {
  const stored = readStored(dir);
  if (stored) writeStored(dir, { url: stored.url, branch: stored.branch });
}

/** The stored token, server-side only. */
export function storedToken(dir: string = dataDir()): string | undefined {
  return readStored(dir)?.token;
}

/**
 * Credentials for one git child process: `GIT_ASKPASS` runs a small script
 * that prints the token (or `x-access-token` as the user name), so neither the
 * token nor the URL carries it in argv. Null when no token is stored.
 */
export function gitAuth(dir: string = dataDir()): GitAuth | null {
  const token = storedToken(dir);
  if (!token) return null;
  return { env: { GIT_ASKPASS: writeAskpass(dir), WORKHOUSE_GIT_TOKEN: token }, secrets: [token] };
}

const ASKPASS_SH = `#!/bin/sh
# Printed by git for each credential prompt; the token comes from the environment.
case "$1" in
  *sername*) printf '%s\n' x-access-token ;;
  *) printf '%s\n' "$WORKHOUSE_GIT_TOKEN" ;;
esac
`;

// cmd.exe expands %WORKHOUSE_GIT_TOKEN% inside quotes, so &, |, < and > in the value stay literal.
// `set /p` prints without a newline: git keeps a trailing CR, which would corrupt the token.
const ASKPASS_CMD = [
  "@echo off",
  'echo %~1| findstr /i /c:"sername" >nul',
  "if errorlevel 1 (",
  '  <nul set /p "=%WORKHOUSE_GIT_TOKEN%"',
  ") else (",
  '  <nul set /p "=x-access-token"',
  ")",
  "exit /b 0", // set /p leaves errorlevel 1 at end of input
  "",
].join("\r\n");

/** Write the askpass script for this platform into the data directory; returns its path. */
function writeAskpass(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === "win32") {
    const file = path.join(dir, "git-askpass.cmd");
    fs.writeFileSync(file, ASKPASS_CMD);
    return file;
  }
  const file = path.join(dir, "git-askpass.sh");
  fs.writeFileSync(file, ASKPASS_SH, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
  return file;
}
