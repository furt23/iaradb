/**
 * A saved query's chart rides in its file's first line, a SQL comment:
 *
 *     -- workhouse:chart {"kind":"bar","x":"region","y":["revenue"],"agg":"sum"}
 *
 * so the file stays plain SQL that any tool can run (pure).
 */

import type { ChartSpec } from "@workhouse/protocol";

const PREFIX = "-- workhouse:chart ";

export function splitQuery(text: string): { chart: ChartSpec | null; body: string } {
  if (!text.startsWith(PREFIX)) return { chart: null, body: text };
  const end = text.indexOf("\n");
  const line = (end < 0 ? text : text.slice(0, end)).replace(/\r$/, "");
  try {
    const chart = JSON.parse(line.slice(PREFIX.length)) as ChartSpec;
    if (!chart || typeof chart !== "object" || typeof chart.kind !== "string") throw new Error("not a chart");
    return { chart, body: end < 0 ? "" : text.slice(end + 1) };
  } catch {
    // not ours after all: keep the line as written
    return { chart: null, body: text };
  }
}

export function joinQuery(chart: ChartSpec | null, body: string): string {
  return chart ? `${PREFIX}${JSON.stringify(chart)}\n${body}` : body;
}
