import "server-only";

import type { AssistRequest } from "@workhouse/protocol";

import { normalizeRelative } from "./kernel/keys";
import { kernels } from "./kernel/manager";

/**
 * Code assistance runs in the notebook's kernel, where the cells' values
 * live. Served by a route handler rather than server actions: the client
 * runs server actions one at a time, and completions must not queue behind
 * saves or each other.
 */
export async function assist(req: AssistRequest): Promise<unknown> {
  const kernel = await kernels.notebookForRun(normalizeRelative(req.path));
  const cell_id = req.cellId;
  switch (req.op) {
    case "complete":
      return kernel.request("assist.complete", { code: req.code, cursor: req.cursor, cell_id });
    case "signature":
      return kernel.request("assist.signature", { code: req.code, cursor: req.cursor, cell_id });
    case "lint":
      return kernel.request("assist.lint", { code: req.code, kind: req.kind, cell_id });
    default:
      throw new Error("unknown assist request");
  }
}
