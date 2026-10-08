"use server";

import type { Cell, NotebookView, Variable } from "@workhouse/protocol";

import { normalizeRelative } from "../kernel/keys";
import { kernels } from "../kernel/manager";
import { attempt, type ActionResult } from "../result";
import { writeNotebookSource } from "../workspace/sources";

export async function openNotebook(path: string): Promise<ActionResult<NotebookView>> {
  return attempt(async () => (await kernels.notebook(normalizeRelative(path))).view);
}

export async function createNotebook(path: string): Promise<ActionResult<NotebookView>> {
  return attempt(async () => {
    const rel = normalizeRelative(path.endsWith(".py") ? path : `${path}.py`);
    return (await kernels.notebook(rel, true)).view;
  });
}

/** The kernel adopts the cells and renders the notebook; the Studio writes the file. */
export async function saveNotebook(path: string, cells: Cell[]): Promise<ActionResult<{ path: string }>> {
  return attempt(async () => {
    const rel = normalizeRelative(path);
    return kernels.exclusive(async () => {
      const saved = await (await kernels.notebookForRun(rel)).request("notebook.save", { cells, persist: false });
      // where the kernel says the notebook is (it may have moved since the editor opened it)
      await writeNotebookSource(saved.path, saved.source);
      return { path: saved.path };
    });
  });
}

export async function notebookVariables(path: string): Promise<ActionResult<Variable[]>> {
  return attempt(async () => (await kernels.notebookForRun(normalizeRelative(path))).request("notebook.variables", {}));
}
