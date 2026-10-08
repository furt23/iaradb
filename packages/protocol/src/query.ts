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
  /** in execution order */
  pipelines: PipelineStats[];
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
