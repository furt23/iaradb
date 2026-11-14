import "server-only";

import type { SystemColumnType } from "@iara/protocol";

import { jobRuns } from "./job_runs";
import { queries } from "./queries";
import { queryTables } from "./query_tables";

export interface SystemTable {
  name: string;
  columns: [string, SystemColumnType][];
  /** a snapshot table's rows, rebuilt on every tick (absent: a log table, whose day files another module appends to) */
  rows?: () => Promise<Record<string, unknown>[]>;
}

/** Every table of the `system` catalog. Adding one: a file here and a line in this list. */
export const TABLES: SystemTable[] = [queries, queryTables, jobRuns];
