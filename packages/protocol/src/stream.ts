/** Server-sent events from the Studio's run endpoint to the browser. */

import type { KernelEvent } from "./methods";
import type { Cell, WidgetValue } from "./notebook";
import type { QueryParams } from "./query";

export type RunStreamEvent =
  | KernelEvent
  | { event: "done"; data: unknown }
  | { event: "failed"; data: { type: string; message: string } };

/** What a run request asks for. */
export type RunRequest =
  /** `autorun`: the cells that read the run cells' values run too (else they turn stale) */
  | { kind: "notebook"; path: string; cells: Cell[]; cellIds: string[] | null; autorun?: boolean }
  /** a widget got a value: the cells that read it run */
  | { kind: "widget"; path: string; cells: Cell[]; name: string; value: WidgetValue }
  | ({ kind: "sql"; query: string } & QueryParams);
