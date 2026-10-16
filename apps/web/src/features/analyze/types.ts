import type { QueryAnalysis } from "@iara/protocol";

/** An analysis as the Studio keeps it: the kernel's result under its id. */
export interface StoredAnalysis extends QueryAnalysis {
  id: string;
}

/** A row of the recent analyses. */
export interface AnalysisSummary {
  id: string;
  /** the query on one line, cut short */
  preview: string;
  at: number;
  elapsed_ms: number;
  rows: number;
}
