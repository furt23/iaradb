import "server-only";

import crypto from "node:crypto";
import path from "node:path";

import type { StudioUser } from "../auth/access";
import { dataDir } from "../compute/store";

/** Where Iara keeps one user's files: <root>/iara/users/<24 hex of sha256 of the lowercased email, or of "local" when the email is empty>. */
export function iaraDir(user: StudioUser, root = dataDir()): string {
  const key = user.email ? user.email.toLowerCase() : "local";
  const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 24);
  return path.join(root, "iara", "users", hash);
}

/** Ids that are safe as file names (uuids and the like). */
export const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
