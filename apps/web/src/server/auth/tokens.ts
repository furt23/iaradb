import "server-only";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dataDir } from "../compute/store";
import { type StudioUser, studioUser } from "./access";

/**
 * Personal access tokens for MCP clients: `dataDir()/tokens.json`. Only the
 * sha256 of a token is stored; the token itself is shown once, at creation.
 * A token acts as its owner, with the owner's current access.
 */

interface TokenRecord {
  id: string;
  email: string;
  name: string;
  hash: string;
  createdAt: number;
  lastUsedAt?: number;
}

export type TokenSummary = Pick<TokenRecord, "id" | "name" | "createdAt" | "lastUsedAt">;

const hashOf = (token: string): string => crypto.createHash("sha256").update(token).digest("hex");
const normal = (email: string): string => email.trim().toLowerCase();

function file(dir: string): string {
  return path.join(dir, "tokens.json");
}

function read(dir: string): TokenRecord[] {
  try {
    return JSON.parse(fs.readFileSync(file(dir), "utf8")) as TokenRecord[];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

function write(dir: string, records: TokenRecord[]): void {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file(dir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file(dir));
}

/** A new token for `email`: its id and the token (shown once, never stored). */
export function createToken(email: string, name: string, dir = dataDir()): { id: string; token: string } {
  const token = `iara_${crypto.randomBytes(32).toString("base64url")}`;
  const id = crypto.randomUUID();
  write(dir, [...read(dir), { id, email: normal(email), name, hash: hashOf(token), createdAt: Date.now() }]);
  return { id, token };
}

export function listTokens(email: string, dir = dataDir()): TokenSummary[] {
  return read(dir)
    .filter((r) => r.email === normal(email))
    .map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt }));
}

export function revokeToken(email: string, id: string, dir = dataDir()): void {
  const records = read(dir);
  const kept = records.filter((r) => !(r.id === id && r.email === normal(email)));
  if (kept.length === records.length) throw new Error("there is no such token");
  write(dir, kept);
}

/** The user a token acts as, with the owner's access as the env lists give it now (null: unknown, removed or a viewer). */
export function userForToken(token: string, dir = dataDir(), env: Record<string, string | undefined> = process.env): StudioUser | null {
  const records = read(dir);
  const record = records.find((r) => r.hash === hashOf(token));
  if (!record) return null;
  const user = studioUser({ email: record.email, email_verified: true }, env);
  if (!user || user.viewer) return null;
  record.lastUsedAt = Date.now();
  write(dir, records);
  return user;
}
