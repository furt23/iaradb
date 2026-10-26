"use server";

import type { Cell, NotebookView, Variable } from "@iara/protocol";

import { requireUser } from "../auth/session";
import { normalizeRelative, notebookKernel } from "../kernel/keys";
import { kernels } from "../kernel/manager";
import { attempt, type ActionResult } from "../result";
import { readNotebookSource, writeNotebookSource } from "../workspace/sources";

/** errors that only say the notebook's cluster is not there to run on */
const NOT_RUNNING = new Set(["ClusterNotRunning", "NoCluster"]);
const notRunning = (e: unknown) => NOT_RUNNING.has((e as { type?: string }).type ?? "");

/** The notebook in its kernel; while its cluster is not running, its cells parsed by the Studio (nothing runs) to edit until it runs. */
export async function openNotebook(path: string): Promise<ActionResult<NotebookView>> {
  return attempt(async () => {
    await requireUser();
    const rel = normalizeRelative(path);
    try {
      return (await kernels.notebook(rel)).view;
    } catch (e) {
      if (!notRunning(e)) throw e;
      const at = kernels.currentPath(rel);
      const { cells } = await kernels.metadata("notebook.parse", { path: at, source: await readNotebookSource(at) });
      return { path: at, cells, states: {} };
    }
  });
}

export async function createNotebook(path: string): Promise<ActionResult<NotebookView>> {
  return attempt(async () => {
    await requireUser();
    const rel = normalizeRelative(path.endsWith(".py") ? path : `${path}.py`);
    try {
      return (await kernels.notebook(rel, true)).view;
    } catch (e) {
      if (!notRunning(e)) throw e;
      // no cluster yet: the Studio writes the new notebook, which opens to edit until one runs
      const { source } = await kernels.metadata("notebook.template", { path: rel });
      await writeNotebookSource(rel, source);
      const { cells } = await kernels.metadata("notebook.parse", { path: rel, source });
      return { path: rel, cells, states: {} };
    }
  });
}

/** The kernel adopts the cells and renders the notebook; the Studio writes the file. */
export async function saveNotebook(path: string, cells: Cell[]): Promise<ActionResult<{ path: string }>> {
  return attempt(async () => {
    await requireUser();
    const rel = normalizeRelative(path);
    return kernels.exclusive(async () => {
      let kernel;
      try {
        kernel = await kernels.notebookForRun(rel);
      } catch (e) {
        if (!notRunning(e)) throw e;
        // no cluster to run on: the Studio writes the file itself, the kernel adopts it when it opens
        const at = kernels.currentPath(rel);
        const { source } = await kernels.metadata("notebook.render", { path: at, source: await readNotebookSource(at), cells });
        await writeNotebookSource(at, source);
        return { path: at };
      }
      const saved = await kernel.request("notebook.save", { cells, persist: false });
      // where the kernel says the notebook is (it may have moved since the editor opened it)
      await writeNotebookSource(saved.path, saved.source);
      return { path: saved.path };
    });
  });
}

export async function notebookVariables(path: string): Promise<ActionResult<Variable[]>> {
  return attempt(async () => {
    await requireUser();
    return (await kernels.notebookForRun(normalizeRelative(path))).request("notebook.variables", {});
  });
}

/** The kernel forgets the outputs too, so a reload does not bring them back. Starts no kernel: with none running there is nothing to clear. */
export async function clearNotebookOutputs(path: string, cellIds: string[] | null): Promise<ActionResult<null>> {
  return attempt(async () => {
    await requireUser();
    const rel = kernels.currentPath(normalizeRelative(path));
    const kernel = kernels.existing(notebookKernel(rel));
    if (kernel) await kernel.request("notebook.clear", { path: rel, cells: cellIds });
    return null;
  });
}
