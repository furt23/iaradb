/** Query runtime: progress, profiles and plans (see iara.exec.query). */

export interface PipelineStats {
  source: string;
  operators: string[];
  sink: string;
  morsels_total: number;
  /** the plan nodes it ran for (pre-order ids into the plan), source first: only measured runs have them */
  nodes?: number[];
  morsels_done: number;
  rows_in: number;
  rows_out: number;
  elapsed_ms: number;
  finished: boolean;
}

/** A pipeline the query will run but has not started. */
export interface PlannedPipeline {
  source: string;
  sink: string;
  /** null when only the run knows it (the output of an earlier pipeline) */
  morsels: number | null;
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
  /** the tables the run read, by location, with the Delta version read (absent from older kernels) */
  reads?: { location: string; version: number | null }[];
  /** the result depends on when it ran or on chance (`now()`, `current_date`, `random()`), not only on what it read */
  volatile?: boolean;
  /** in execution order */
  pipelines: PipelineStats[];
  /** pipelines not started yet, in the order they will run (absent from older kernels) */
  pending?: PlannedPipeline[];
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

/** A saved query's parameter kinds; `date` values travel as ISO `YYYY-MM-DD` strings. */
export type QueryParamType = "text" | "number" | "boolean" | "date" | "select";

/** Values for a query's `:name` placeholders, with the kind of each (a `date` string becomes a date in the kernel). */
export interface QueryParams {
  params?: Record<string, string | number | boolean | null>;
  param_types?: Record<string, QueryParamType>;
}

/** A query run with profiling (the Studio's Analyze screen). */
export interface QueryAnalysis {
  query: string;
  /** where the query came from (the Studio's own field: not set by the kernel) */
  source?: string;
  /** the parameter values it ran with (the Studio's own fields, kept to run it again) */
  params?: QueryParams["params"];
  param_types?: QueryParams["param_types"];
  /** unix milliseconds */
  at: number;
  rows: number;
  plan: AnalyzedNode;
  /** the plan as text */
  text: string;
  profile: QueryProfile;
  requests?: StorageRequests;
}
