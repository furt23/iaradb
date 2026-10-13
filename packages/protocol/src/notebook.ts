/** Notebooks, cells and their outputs (see workhouse.kernel.notebook). */

import type { PlanNode, QueryProfile } from "./query";
import type { ResultMeta } from "./results";

export type CellKind = "python" | "sql" | "markdown";

export interface Cell {
  id: string;
  kind: CellKind;
  /** Python source, SQL query or markdown text. */
  code: string;
  /** marimo function name (`_` for anonymous cells). */
  name: string;
  /** SQL cells: the variable the result is bound to. */
  output: string | null;
  config: Record<string, unknown>;
  /** marimo `with app.setup:` block. */
  setup: boolean;
}

export type CellStatus = "idle" | "queued" | "running" | "done" | "error" | "cancelled";

export interface TableOutput {
  type: "table";
  result: ResultMeta;
  /** present for SQL cells and lazy frames */
  profile?: QueryProfile;
  plan?: PlanNode;
}

export interface TextOutput {
  type: "text";
  text: string;
}

export interface HtmlOutput {
  type: "html";
  html: string;
}

export interface ImageOutput {
  type: "image";
  mime: string;
  /** base64 */
  data: string;
}

export interface MarkdownOutput {
  type: "markdown";
  text: string;
}

export interface ErrorOutput {
  type: "error";
  ename: string;
  evalue: string;
  traceback: string;
}

export type CellOutput = TableOutput | TextOutput | HtmlOutput | ImageOutput | MarkdownOutput | ErrorOutput;

export interface StreamChunk {
  stream: "stdout" | "stderr";
  text: string;
}

export interface CellState {
  status: CellStatus;
  /** the cell was edited since its last run */
  stale: boolean;
  output: CellOutput | null;
  streams: StreamChunk[];
  elapsed_ms: number | null;
}

export type WidgetKind = "text" | "number" | "dropdown" | "multiselect" | "checkbox" | "date";

/** A widget value as JSON: text, number, choice, list of choices, boolean, or an ISO date (null: no date). */
export type WidgetValue = string | number | boolean | string[] | null;

/** A notebook widget (`wh.widgets.*`): what a cell defined. */
export interface WidgetDefinition {
  name: string;
  kind: WidgetKind;
  label: string;
  default: WidgetValue;
  /** dropdown and multiselect */
  choices: (string | number)[] | null;
  min: number | null;
  max: number | null;
  step: number | null;
}

export interface WidgetsState {
  definitions: WidgetDefinition[];
  values: Record<string, WidgetValue>;
}

export interface NotebookView {
  /** relative to the workspace root */
  path: string;
  cells: Cell[];
  states: Record<string, CellState>;
  /** the widgets the cells defined (absent from older kernels) */
  widgets?: WidgetsState;
}

export interface RunResult {
  ran: string[];
  interrupted: boolean;
}

export interface Variable {
  name: string;
  type: string;
  summary: string;
  cell_id: string | null;
}
