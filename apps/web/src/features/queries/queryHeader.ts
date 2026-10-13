/**
 * A saved query keeps its settings in leading SQL comments, one per line:
 *
 *     -- workhouse:chart {"kind":"bar","x":"region","y":["revenue"],"agg":"sum"}
 *     -- workhouse:params {"region":{"type":"text","default":"EU"}}
 *
 * so the file stays plain SQL that any tool can run. Lines with other keys are
 * kept as written (pure).
 */

import type { ChartSpec, QueryParamType } from "@workhouse/protocol";

const PREFIX = "-- workhouse:";
const LINE = /^-- workhouse:([A-Za-z][\w-]*) (.*)$/;

export const PARAM_TYPES: readonly QueryParamType[] = ["text", "number", "boolean", "date", "select"];

/** How one `:name` placeholder of a query is asked for. */
export interface ParamSpec {
  type: QueryParamType;
  default?: string | number | boolean;
  /** the choices of a `select` */
  options?: string[];
}

export type ParamSpecs = Record<string, ParamSpec>;

/** A header line of a key this code does not know, with its position among the header lines. */
export interface ExtraLine {
  at: number;
  line: string;
}

export interface QueryParts {
  chart: ChartSpec | null;
  params: ParamSpecs | null;
  body: string;
  extra?: ExtraLine[];
}

function parseChart(json: string): ChartSpec | null {
  try {
    const chart = JSON.parse(json) as ChartSpec;
    return chart && typeof chart === "object" && typeof chart.kind === "string" ? chart : null;
  } catch {
    return null;
  }
}

function parseSpec(raw: unknown): ParamSpec | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const type = PARAM_TYPES.includes(r.type as QueryParamType) ? (r.type as QueryParamType) : "text";
  const spec: ParamSpec = { type };
  if (Array.isArray(r.options)) spec.options = r.options.filter((o): o is string => typeof o === "string");
  if (typeof r.default === "string" || typeof r.default === "number" || typeof r.default === "boolean") spec.default = r.default;
  return spec;
}

function parseParams(json: string): ParamSpecs | null {
  try {
    const raw = JSON.parse(json) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const specs: ParamSpecs = {};
    for (const [name, value] of Object.entries(raw)) {
      const spec = parseSpec(value);
      if (!spec) return null;
      specs[name] = spec;
    }
    return specs;
  } catch {
    return null;
  }
}

/** The settings in the header lines of `text`, the query that follows them, and the header lines of other keys. */
export function splitQuery(text: string): Required<QueryParts> {
  let chart: ChartSpec | null = null;
  let params: ParamSpecs | null = null;
  const extra: ExtraLine[] = [];
  let pos = 0;
  let count = 0;
  while (text.startsWith(PREFIX, pos)) {
    const end = text.indexOf("\n", pos);
    const line = (end < 0 ? text.slice(pos) : text.slice(pos, end)).replace(/\r$/, "");
    const m = LINE.exec(line);
    if (!m) break;
    const [, key, json] = m;
    if (key === "chart" && !chart) {
      chart = parseChart(json);
      if (!chart) break; // not ours after all: keep the line (and what follows) as written
    } else if (key === "params" && !params) {
      params = parseParams(json);
      if (!params) break;
    } else {
      extra.push({ at: count, line });
    }
    count++;
    pos = end < 0 ? text.length : end + 1;
  }
  return { chart, params, extra, body: text.slice(pos) };
}

/** The file text for the header settings and the query. */
export function joinQuery({ chart, params, body, extra = [] }: QueryParts): string {
  const known: string[] = [];
  if (chart) known.push(`${PREFIX}chart ${JSON.stringify(chart)}`);
  if (params && Object.keys(params).length > 0) known.push(`${PREFIX}params ${JSON.stringify(params)}`);
  const lines: string[] = [];
  const others = [...extra].sort((a, b) => a.at - b.at);
  let k = 0;
  for (let at = 0; k < known.length || others.length > 0; at++) {
    if (others.length > 0 && others[0].at <= at) lines.push(others.shift()!.line);
    else if (k < known.length) lines.push(known[k++]);
  }
  return lines.map((l) => `${l}\n`).join("") + body;
}
