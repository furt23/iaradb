/** Query runtime: progress, profiles and plans (see workhouse.exec.query). */

export interface PipelineStats {
  source: string;
  operators: string[];
  sink: string;
  morsels_total: number;
  morsels_done: number;
  rows_in: number;
  rows_out: number;
  elapsed_ms: number;
  finished: boolean;
}

export interface QueryProfile {
  id: number;
  elapsed_ms: number;
  cancelled: boolean;
  /** bytes of operator memory at the query's peak (absent from older kernels) */
  memory_peak?: number;
  /** bytes written to spill files (larger-than-memory operators) */
  spilled_bytes?: number;
  /** object-store requests the run made (absent when the engine does not report them) */
  requests?: StorageRequests;
  /** in execution order */
  pipelines: PipelineStats[];
}

/** Object-store requests of a run, by kind. */
export interface StorageRequests {
  list: number;
  head: number;
  get: number;
  bytes: number;
}

export interface PlanNode {
  /** operator kind, e.g. `HashJoin`, `ParquetScan` */
  name: string;
  /** full description of the operator */
  detail: string;
  role: "probe" | "build" | null;
  children: PlanNode[];
}

export interface ExplainResult {
  plan: PlanNode;
  /** optimized logical + physical plan as text */
  text: string;
}

/** What one operator did in a run. */
export interface OperatorMetrics {
  rows_out: number;
  elapsed_ms: number;
  batches?: number;
  memory_peak?: number;
  spilled_bytes?: number;
}

/** A plan node of an analysis: its run metrics when the engine reports them. */
export interface AnalyzedNode {
  name: string;
  detail: string;
  role: "probe" | "build" | null;
  metrics: OperatorMetrics | null;
  children: AnalyzedNode[];
}

/** A query run with profiling (the Studio's Analyze screen). */
export interface QueryAnalysis {
  query: string;
  /** where the query came from (the Studio's own field: not set by the kernel) */
  source?: string;
  /** unix milliseconds */
  at: number;
  rows: number;
  plan: AnalyzedNode;
  /** the plan as text */
  text: string;
  profile: QueryProfile;
  requests?: StorageRequests;
}
