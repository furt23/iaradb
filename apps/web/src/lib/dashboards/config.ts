/** `dashboard.toml` and the ids of dashboards and their widgets (pure). */

import { parse, stringify } from "smol-toml";

import { parseCron } from "@/lib/cron";

import type { DashboardConfig, RefreshSchedule } from "./types";

/** Dashboards and widgets are named by 8 random characters. */
export const ID = /^[a-z0-9]{8}$/;
export const DEFAULT_REFRESH_MINUTES = 10;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A new id (not checked against the existing ones: 36^8 of them). */
export function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => ALPHABET[b % ALPHABET.length]).join("");
}

function optionalText(v: unknown, what: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Error(`${what} is text`);
  return v.trim() || undefined;
}

/** `[schedule]`: `cron` (UTC) and `enabled` (true when omitted). */
function scheduleOf(v: unknown): RefreshSchedule | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("schedule is a table");
  const { cron, enabled = true } = v as Record<string, unknown>;
  if (typeof cron !== "string" || !cron.trim()) throw new Error("schedule.cron is missing");
  try {
    parseCron(cron);
  } catch (e) {
    throw new Error(`schedule.cron: ${(e as Error).message}`);
  }
  if (typeof enabled !== "boolean") throw new Error("schedule.enabled is true or false");
  return { cron: cron.trim(), enabled };
}

/** Read a `dashboard.toml` (throws with what is wrong; unknown keys are ignored). */
export function parseConfig(toml: string): DashboardConfig {
  let cfg: Record<string, unknown>;
  try {
    cfg = parse(toml) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`not valid TOML: ${(e as Error).message}`);
  }
  if (typeof cfg.id !== "string" || !ID.test(cfg.id)) throw new Error("id is 8 characters of a-z and 0-9");
  const title = typeof cfg.title === "string" ? cfg.title.trim() : "";
  if (!title) throw new Error("title is missing");
  const refresh = cfg.refresh_minutes ?? DEFAULT_REFRESH_MINUTES;
  if (typeof refresh !== "number" || !Number.isInteger(refresh) || refresh < 1 || refresh > 24 * 60) {
    throw new Error("refresh_minutes is a whole number between 1 and 1440");
  }
  const description = optionalText(cfg.description, "description");
  const cluster = optionalText(cfg.cluster, "cluster");
  const schedule = scheduleOf(cfg.schedule);
  return { id: cfg.id, title, ...(description && { description }), ...(cluster && { cluster }), refresh_minutes: refresh, ...(schedule && { schedule }) };
}

/** The file of a dashboard's config. */
export function configToml(c: DashboardConfig): string {
  const cfg: Record<string, unknown> = { id: c.id, title: c.title };
  if (c.description) cfg.description = c.description;
  if (c.cluster) cfg.cluster = c.cluster;
  cfg.refresh_minutes = c.refresh_minutes;
  if (c.schedule) cfg.schedule = c.schedule.enabled ? { cron: c.schedule.cron } : { cron: c.schedule.cron, enabled: false };
  return `${stringify(cfg)}\n`;
}
