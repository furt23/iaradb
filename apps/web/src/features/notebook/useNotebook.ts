"use client";

import type { Cell, CellKind, NotebookView, RunStreamEvent } from "@workhouse/protocol";
import { useCallback, useEffect, useReducer, useRef } from "react";

import { useNotify } from "@/features/shell/notify";
import { streamEvents } from "@/lib/sse";
import { interruptKernel, restartKernel } from "@/server/actions/kernels";
import { saveNotebook } from "@/server/actions/notebooks";

import { initialState, makeCell, notebookReducer } from "./notebookState";

const AUTOSAVE_MS = 1200;

export function kernelKeyOf(path: string): string {
  return `notebook:${path}`;
}

/** Editor state plus the commands that talk to the server. */
export function useNotebook(view: NotebookView, onRunFinished?: () => void) {
  const [state, dispatch] = useReducer(notebookReducer, view, initialState);
  const notify = useNotify();
  const cellsRef = useRef(state.cells);
  cellsRef.current = state.cells;
  const kernelKey = kernelKeyOf(state.path);

  const save = useCallback(async () => {
    const r = await saveNotebook(state.path, cellsRef.current);
    if (r.ok) dispatch({ type: "saved" });
    else notify(`Save failed: ${r.error.message}`, "error");
  }, [state.path, notify]);

  useEffect(() => {
    if (!state.dirty) return;
    const t = setTimeout(save, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [state.dirty, state.cells, save]);

  // closing the tab must not drop edits still waiting for the autosave
  const pending = useRef({ dirty: state.dirty, save });
  pending.current = { dirty: state.dirty, save };
  useEffect(
    () => () => {
      if (pending.current.dirty) void pending.current.save();
    },
    [],
  );

  const run = useCallback(
    async (cellIds: string[] | null) => {
      const cells = cellsRef.current;
      dispatch({ type: "run", cells, at: Date.now() });
      try {
        await streamEvents("/api/run", { kind: "notebook", path: state.path, cells, cellIds }, (e) => {
          const ev = e as RunStreamEvent;
          if (ev.event === "cell.state" || ev.event === "cell.stream" || ev.event === "progress") {
            dispatch({ type: ev.event, data: ev.data } as Parameters<typeof dispatch>[0]);
          } else if (ev.event === "failed") {
            notify(ev.data.message, "error");
          }
        });
      } catch (e) {
        notify((e as Error).message, "error");
      } finally {
        dispatch({ type: "finished", at: Date.now() });
        onRunFinished?.();
      }
      void save();
    },
    [state.path, notify, onRunFinished, save],
  );

  const interrupt = useCallback(async () => {
    const r = await interruptKernel(kernelKey);
    if (!r.ok) notify(r.error.message, "error");
  }, [kernelKey, notify]);

  const restart = useCallback(async () => {
    const r = await restartKernel(kernelKey);
    if (r.ok) {
      dispatch({ type: "reset" });
      notify("Kernel restarted: every value was cleared", "info");
    } else notify(r.error.message, "error");
  }, [kernelKey, notify]);

  const addCell = useCallback((index: number, kind: CellKind) => {
    const cell = makeCell(kind, cellsRef.current);
    dispatch({ type: "add", index, cell });
    return cell;
  }, []);

  const edit = useCallback((id: string, patch: Partial<Pick<Cell, "code" | "kind" | "output" | "config">>) => dispatch({ type: "edit", id, patch }), []);
  const remove = useCallback((id: string) => dispatch({ type: "remove", id }), []);
  const move = useCallback((id: string, delta: -1 | 1) => dispatch({ type: "move", id, delta }), []);
  const reorder = useCallback((id: string, over: string) => dispatch({ type: "reorder", id, over }), []);

  /** The kernel was replaced elsewhere (attached to another cluster): forget outputs and states. */
  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  return { state, kernelKey, save, run, interrupt, restart, reset, addCell, edit, remove, move, reorder };
}
