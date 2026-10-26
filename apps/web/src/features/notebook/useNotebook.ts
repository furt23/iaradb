"use client";

import type { Cell, CellKind, NotebookView, RunRequest, RunStreamEvent, WidgetValue } from "@iara/protocol";
import { useCallback, useEffect, useReducer, useRef } from "react";

import { useCatalogRefresh } from "@/features/data/useCatalogRefresh";
import { useNotify } from "@/features/shell/notify";
import { streamEvents } from "@/lib/sse";
import { interruptKernel, restartKernel } from "@/server/actions/kernels";
import { clearNotebookOutputs, saveNotebook } from "@/server/actions/notebooks";

import { useAutorun } from "./autorun";
import { initialState, makeCell, notebookReducer } from "./notebookState";

const AUTOSAVE_MS = 1200;

export function kernelKeyOf(path: string): string {
  return `notebook:${path}`;
}

/** Editor state plus the commands that talk to the server. */
export function useNotebook(view: NotebookView, onRunFinished?: () => void) {
  const [state, dispatch] = useReducer(notebookReducer, view, initialState);
  const notify = useNotify();
  const refreshCatalog = useCatalogRefresh();
  const cellsRef = useRef(state.cells);
  cellsRef.current = state.cells;
  const kernelKey = kernelKeyOf(state.path);
  const [autorun, setAutorun] = useAutorun(state.path);

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

  /** Send a run request and follow the kernel's events until it ends. */
  const execute = useCallback(
    async (request: Extract<RunRequest, { kind: "notebook" | "widget" }>) => {
      dispatch({ type: "run", cells: request.cells, at: Date.now() });
      let catalogChanged = false;
      try {
        await streamEvents("/api/run", request, (e) => {
          const ev = e as RunStreamEvent;
          if (ev.event === "catalog.changed") catalogChanged = true;
          else if (ev.event === "cell.state" || ev.event === "cell.stream" || ev.event === "progress" || ev.event === "widgets.changed") {
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
        if (catalogChanged) refreshCatalog();
      }
      void save();
    },
    [notify, onRunFinished, save, refreshCatalog],
  );

  // one run at a time: a run asked for while another goes on would start as soon as that one is stopped
  const runningRef = useRef(state.running);
  runningRef.current = state.running;
  const run = useCallback(
    async (cellIds: string[] | null) => {
      if (runningRef.current) return;
      runningRef.current = true;
      await execute({ kind: "notebook", path: state.path, cells: cellsRef.current, cellIds, autorun });
    },
    [execute, state.path, autorun],
  );

  /** A widget got a value: the cells that read it run. Changes go to the kernel one after the other. */
  const widgetQueue = useRef<Promise<unknown>>(Promise.resolve());
  const setWidget = useCallback(
    (name: string, value: WidgetValue) => {
      dispatch({ type: "widget.value", name, value });
      const send = () => execute({ kind: "widget", path: state.path, cells: cellsRef.current, name, value });
      widgetQueue.current = widgetQueue.current.then(send, send);
    },
    [execute, state.path],
  );

  const interrupt = useCallback(async () => {
    const r = await interruptKernel(kernelKey);
    if (!r.ok) notify(r.error.message, "error");
  }, [kernelKey, notify]);

  /** Resolves to whether the kernel restarted. */
  const restart = useCallback(async () => {
    const r = await restartKernel(kernelKey);
    if (r.ok) {
      dispatch({ type: "restarted" });
      notify("Kernel restarted: every value was cleared", "info");
      return true;
    }
    notify(r.error.message, "error");
    return false;
  }, [kernelKey, notify]);

  const restartAndRunAll = useCallback(async () => {
    if (await restart()) await run(null);
  }, [restart, run]);

  /** Outputs of `cellIds` (null: every cell) are cleared in the editor and in the kernel. */
  const clearOutputs = useCallback(
    async (cellIds: string[] | null) => {
      dispatch({ type: "clearOutputs", cells: cellIds });
      const r = await clearNotebookOutputs(state.path, cellIds);
      if (!r.ok) notify(r.error.message, "error");
    },
    [state.path, notify],
  );

  const restartAndClear = useCallback(async () => {
    if (await restart()) await clearOutputs(null);
  }, [restart, clearOutputs]);

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

  return {
    state,
    kernelKey,
    autorun,
    setAutorun,
    save,
    run,
    setWidget,
    interrupt,
    restart,
    restartAndClear,
    restartAndRunAll,
    clearOutputs,
    reset,
    addCell,
    edit,
    remove,
    move,
    reorder,
  };
}
