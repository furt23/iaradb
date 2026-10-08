/** Server-sent events from the Studio's run endpoint to the browser. */

import type { KernelEvent } from "./methods";
import type { Cell } from "./notebook";

export type RunStreamEvent =
  | KernelEvent
  | { event: "done"; data: unknown }
  | { event: "failed"; data: { type: string; message: string } };

/** What a run request asks for. */
export type RunRequest =
  | { kind: "notebook"; path: string; cells: Cell[]; cellIds: string[] | null }
  | { kind: "sql"; query: string };
