import type { HistoryEntry } from "@iara/protocol";

/** One run in the Studio's query log. */
export interface QueryLogEntry extends Omit<HistoryEntry, "ts"> {
  id: string;
  /** unix milliseconds */
  ts: number;
  /** who ran it (null: a scheduled run, or sign-in is off and nobody is known) */
  user: string | null;
  /** the kernel it ran in: `workspace`, `notebook:<path>`, `job:<run>`, `dashboard:<id>`, `assistant`, `metadata`, `serving` */
  kernel: string;
  cluster: string | null;
}

/** One line of `query_tables`: a table a run read or wrote. */
export interface QueryTableRow {
  query_id: string;
  ts: number;
  user: string | null;
  kernel: string;
  source: string;
  access: "read" | "write";
  table: string | null;
  location: string;
  version: number | null;
  operation: string | null;
}

/** What ran: a notebook, a query file or the SQL editor, a job, a dashboard, the chat agent. */
export interface LineageSource {
  kind: "notebook" | "sql" | "job" | "dashboard" | "assistant" | "other";
  id: string;
  label: string;
}

/** The last time a source read or wrote a table. */
export interface LineageUse {
  source: LineageSource;
  user: string | null;
  ts: number;
  version: number | null;
  /** a write: the tables the same run read */
  inputs: string[];
}

export interface TableLineage {
  writers: LineageUse[];
  readers: LineageUse[];
}
