/** Parameters of a saved query: finding `:name` placeholders, their specs and their values (pure). */

import type { QueryParams } from "@workhouse/protocol";

import type { ParamSpec, ParamSpecs } from "./queryHeader";

/** What an input holds: text from a field, or a switch. */
export type ParamRaw = string | boolean;

const IDENT_START = /[A-Za-z_]/;
const IDENT = /[A-Za-z0-9_]/;

/**
 * The `:name` placeholders of `sql`, in order of first appearance. Quoted text
 * ('..', "..", $$..$$ and $tag$..$tag$), comments and `::` casts hold none.
 */
export function detectParams(sql: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      // ends at its next unescaped twin ('' or "" escape it)
      i++;
      while (i < sql.length && !(sql[i] === c && sql[i + 1] !== c)) i += sql[i] === c ? 2 : 1;
      i++;
    } else if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end < 0 ? sql.length : end + tag[0].length;
      } else {
        i++;
      }
    } else if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
    } else if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (c === ":") {
      if (sql[i + 1] === ":") {
        i += 2;
      } else if (IDENT_START.test(sql[i + 1] ?? "")) {
        let j = i + 2;
        while (j < sql.length && IDENT.test(sql[j])) j++;
        const name = sql.slice(i + 1, j);
        if (!found.includes(name)) found.push(name);
        i = j;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  return found;
}

/** A spec for each detected name, in query order: the saved one, or plain text. Specs of names no longer in the query drop out. */
export function mergeSpecs(detected: string[], saved: ParamSpecs | null): ParamSpecs {
  const out: ParamSpecs = {};
  for (const name of detected) out[name] = saved?.[name] ?? { type: "text" };
  return out;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** The value the kernel gets for an input; `undefined` when there is none (empty, or not valid for the type). */
export function coerce(spec: ParamSpec, raw: ParamRaw | number | null | undefined): string | number | boolean | undefined {
  switch (spec.type) {
    case "boolean":
      if (typeof raw === "boolean") return raw;
      return raw === "true" ? true : raw === "false" || raw === undefined || raw === null || raw === "" ? false : undefined;
    case "number": {
      if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
      if (typeof raw !== "string" || !raw.trim()) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case "date":
      return typeof raw === "string" && validDate(raw.trim()) ? raw.trim() : undefined;
    case "select":
      if (typeof raw !== "string" || raw === "") return undefined;
      return spec.options && !spec.options.includes(raw) ? undefined : raw;
    default:
      return typeof raw === "string" && raw !== "" ? raw : typeof raw === "number" ? String(raw) : undefined;
  }
}

/** What an input shows: the value typed, else the spec's default. */
export function shown(spec: ParamSpec, value: ParamRaw | undefined): ParamRaw {
  if (value !== undefined) return value;
  if (spec.type === "boolean") return spec.default === true || spec.default === "true";
  return spec.default === undefined ? "" : String(spec.default);
}

/** Values for the kernel, and the names that have no (valid) value. */
export function resolveParams(specs: ParamSpecs, values: Record<string, ParamRaw>): { query: QueryParams; missing: string[] } {
  const params: NonNullable<QueryParams["params"]> = {};
  const param_types: NonNullable<QueryParams["param_types"]> = {};
  const missing: string[] = [];
  for (const [name, spec] of Object.entries(specs)) {
    const v = coerce(spec, shown(spec, values[name]));
    if (v === undefined) missing.push(name);
    else {
      params[name] = v;
      param_types[name] = spec.type;
    }
  }
  return { query: Object.keys(specs).length > 0 ? { params, param_types } : {}, missing };
}
