/**
 * Read grants: which tables each user's queries may read (pure).
 *
 * Enforced on the mediated paths only: dashboards, shared views, the AI
 * assistant and MCP. Each sends the kernel an `allow` list, which the engine
 * checks for every table, refuses files and refuses writes under it. Not
 * enforced: notebooks and SQL tabs, which an editor runs as themselves.
 */

import type { StudioUser } from "../auth/access";

export interface Grant {
  /** a lowercase email, `editors` or `viewers` */
  to: string;
  /** `*`, or 1-3 dot-separated parts: a catalog, `catalog.schema` or `catalog.schema.table` */
  on: string;
}

export const DEFAULT_GRANTS: Grant[] = [{ to: "editors", on: "*" }];

const NAME = /^[a-z_][a-z0-9_]*$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** The grant with `to` and `on` normalized (throws with what is wrong). */
export function checkedGrant(g: unknown): Grant {
  if (!g || typeof g !== "object") throw new Error("a grant is an object with to and on");
  const { to, on } = g as Record<string, unknown>;
  if (typeof to !== "string" || typeof on !== "string") throw new Error("a grant has to and on as text");
  const t = to.trim().toLowerCase();
  const o = on.trim().toLowerCase();
  if (t !== "editors" && t !== "viewers" && !EMAIL.test(t)) throw new Error(`${t} is not an email, editors or viewers`);
  const parts = o.split(".");
  if (o !== "*" && (parts.length > 3 || !parts.every((p) => NAME.test(p)))) throw new Error(`${o} is not *, a catalog, catalog.schema or catalog.schema.table`);
  return { to: t, on: o };
}

/** What the user may read: null (everything) for admins, else the sorted `on`s of the grants that name them or their role. */
export function allowFor(user: StudioUser, grants: Grant[]): string[] | null {
  if (user.admin) return null;
  const email = user.email.toLowerCase();
  const role = user.viewer ? "viewers" : "editors";
  const ons = grants.filter((g) => g.to === email || g.to === role).map((g) => g.on);
  return [...new Set(ons)].sort();
}

/** Whether the table `full` (catalog.schema.table) is covered by an allow list (null: unchecked). */
export function canRead(allow: string[] | null, full: string): boolean {
  if (allow === null) return true;
  const name = full.toLowerCase();
  return allow.some((a) => a === "*" || a === name || name.startsWith(`${a}.`));
}
