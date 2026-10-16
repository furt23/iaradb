import type { QueryAnalysis } from "@iara/protocol";

import { formatBytes, formatCount, formatDuration } from "@/lib/format";

/** One summary card of an analysis. */
export interface Fact {
  label: string;
  value: string;
  hint?: string;
}

/** The summary cards of an analysis (pure). Storage requests only when the engine reports them. */
export function summaryFacts(a: Pick<QueryAnalysis, "rows" | "profile" | "requests">): Fact[] {
  const p = a.profile;
  const facts: Fact[] = [
    { label: "Total time", value: formatDuration(p.elapsed_ms) },
    { label: "Rows", value: formatCount(a.rows) },
    { label: "Peak memory", value: p.memory_peak == null ? "—" : formatBytes(p.memory_peak) },
    { label: "Spilled", value: formatBytes(p.spilled_bytes ?? 0) },
    { label: "Pipelines", value: formatCount(p.pipelines.length) },
  ];
  if (a.requests) {
    const r = a.requests;
    facts.push({
      label: "Storage requests",
      value: `${formatCount(r.get)} GET · ${formatCount(r.list)} LIST · ${formatCount(r.head)} HEAD`,
      hint: `${formatBytes(r.bytes)} read`,
    });
  }
  return facts;
}
