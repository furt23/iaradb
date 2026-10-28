"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import type { CellKind, NotebookView, Variable, WidgetValue } from "@iara/protocol";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCompute } from "@/features/compute/ComputeProvider";
import { NotebookClusterSelect } from "@/features/compute/NotebookClusterSelect";
import { FindContext } from "@/features/editor/findHighlight";
import { IaraPanel } from "@/features/iara/IaraPanel";
import { useNotify } from "@/features/shell/notify";
import { useShell } from "@/features/shell/ShellProvider";
import { FileActionsMenu } from "@/features/workbench/FileActionsMenu";
import { fileIdOf } from "@/features/workbench/fileIdRegistry";
import { notebookVariables } from "@/server/actions/notebooks";

import { AddCellBar } from "./AddCellBar";
import { CellList } from "./CellList";
import { cellShortcut } from "./cellShortcuts";
import { FindBar } from "./FindBar";
import { useNotebookIara } from "./iaraBridge";
import { IaraNewCell } from "./IaraNewCell";
import { IDLE, isStale, setupCell, setupError, totalElapsed, visibleCells } from "./notebookState";
import { NotebookSidePanel } from "./NotebookSidePanel";
import { NotebookToolbar } from "./NotebookToolbar";
import { RunPanel } from "./RunPanel";
import { SetupDialog } from "./SetupDialog";
import { WidgetBar } from "./WidgetBar";
import { SortableCell } from "./SortableCell";
import { cellLink, useCellAnchor } from "./useCellAnchor";
import { useNotebook } from "./useNotebook";
import { useNotebookFind } from "./useNotebookFind";

type Schema = Record<string, { name: string }[]>;

/** The run calls while the notebook's cluster does not run: nothing runs, the editor stays usable. */
const noRun: (cellIds: string[] | null) => Promise<void> = async () => {};

const FRAME_TYPES = new Set(["DataFrame", "LazyFrame", "Table", "RecordBatch"]);

/** Catalog tables plus the notebook's DataFrames, for SQL completion. */
function sqlSchema(schema: Schema, variables: Variable[]): Schema {
  const frames = variables.filter((v) => FRAME_TYPES.has(v.type) && !(v.name in schema));
  return frames.length ? { ...schema, ...Object.fromEntries(frames.map((v) => [v.name, []])) } : schema;
}

/** Which cells show their output (hidden ones are remembered per session). */
function useHiddenOutputs() {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback(
    (id: string) =>
      setHidden((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  return { hidden, toggle, setHidden };
}

export function NotebookEditor({ initial, schema }: { initial: NotebookView; schema: Schema }) {
  // the outline (this tab's) and Iara (open in every tab) share the right side: opening one closes the other
  const { iaraOpen, setIaraOpen } = useShell();
  const [outlineOpen, setOutlineOpen] = useState(false);
  const outlineShown = outlineOpen && !iaraOpen;
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const [variables, setVariables] = useState<Variable[]>([]);
  const refreshVariables = useCallback(async () => {
    const r = await notebookVariables(initial.path);
    if (r.ok) setVariables(r.data);
  }, [initial.path]);
  const nb = useNotebook(initial, refreshVariables);
  const { state, addCell, clearOutputs, save } = nb;
  const notify = useNotify();
  const outputs = useHiddenOutputs();
  const completionSchema = useMemo(() => sqlSchema(schema, variables), [schema, variables]);
  // the notebook opens without its cluster running: it can be edited, its cells cannot run until it does
  const [clusterId, setClusterId] = useState<string | null>(null);
  const { overview } = useCompute();
  const canRun = overview?.clusters.find((c) => c.id === clusterId)?.state === "running";
  const run = canRun ? nb.run : noRun;
  // widgets re-run the cells that read them
  const setWidget = useCallback(
    (name: string, value: WidgetValue) => {
      if (canRun) nb.setWidget(name, value);
    },
    [canRun, nb.setWidget],
  );

  useEffect(() => {
    void refreshVariables();
  }, [refreshVariables]);

  const runOne = useCallback((id: string) => run([id]), [run]);
  // a stop asked for stays shown until the run has ended
  const [stopping, setStopping] = useState(false);
  const { interrupt } = nb;
  const stop = useCallback(() => {
    setStopping(true);
    void interrupt();
  }, [interrupt]);
  useEffect(() => {
    if (!state.running) setStopping(false);
  }, [state.running]);
  const clearOne = useCallback((id: string) => clearOutputs([id]), [clearOutputs]);
  // a cell link lasts once the file holds the cell ids: save first
  const copyLink = useCallback(
    async (id: string) => {
      await save();
      await navigator.clipboard.writeText(cellLink(state.path, id));
      notify("Link to the cell copied", "success");
    },
    [save, state.path, notify],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  useCellAnchor(rootRef);
  const iara = useNotebookIara({ nb, variables, rootRef, canRun });
  // the cell just added takes the focus
  const [fresh, setFresh] = useState<string | null>(null);
  const addAt = useCallback((index: number, kind: CellKind) => setFresh(addCell(index, kind).id), [addCell]);
  // the setup cell is edited in its dialog: the list, the outline and every index below are those of the visible cells
  const cells = useMemo(() => visibleCells(state.cells), [state.cells]);
  const setup = useMemo(() => setupCell(state.cells), [state.cells]);
  // a cell Iara proposes shows before the visible cell at `at` (cells.length: after the last), as showChange would insert it; one not visible (the setup cell) gives 0
  const adding = iara.review?.change.action === "insert_cell" ? iara.review : null;
  const at = adding ? (adding.cellId === null ? cells.length : cells.findIndex((c) => c.id === adding.cellId) + 1) : -1;
  const ghost = adding && <IaraNewCell review={adding} canRun={canRun} schema={completionSchema} />;
  const failure = setupError(state);
  const [setupOpen, setSetupOpen] = useState(false);
  const saveSetup = useCallback((id: string, code: string) => nb.edit(id, { code }), [nb.edit]);
  // run after the edit has rendered: `run` sends the cells as the editor holds them
  const runSetup = useCallback(
    (id: string, code: string) => {
      nb.edit(id, { code });
      setTimeout(() => void run([id]), 0);
    },
    [nb.edit, run],
  );
  const find = useNotebookFind(cells, nb.edit, rootRef);
  const findContext = useMemo(() => ({ regexp: find.highlight }), [find.highlight]);
  // the run keys act on the cell the focus is in; stop and find work from anywhere in this notebook
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const shortcut = cellShortcut(e);
      const root = rootRef.current;
      // nothing focused yet (just opened): Ctrl+F is for the notebook that is showing
      const inside = root?.contains(e.target as Node) || (shortcut === "find" && e.target === document.body && root?.offsetParent != null);
      if (!shortcut || e.defaultPrevented || !inside) return;
      e.preventDefault();
      if (shortcut === "find") return find.show();
      if (shortcut === "stop") {
        if (state.running) stop();
        return;
      }
      const cellId = (e.target as Element).closest("[data-cell-id]")?.getAttribute("data-cell-id");
      const at = cells.findIndex((c) => c.id === cellId);
      if (at < 0 || state.running) return;
      const picked = shortcut === "runAbove" ? cells.slice(0, at) : cells.slice(at);
      if (picked.length) void run(picked.map((c) => c.id));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cells, state.running, stop, run, find.show]);
  const last = cells.length - 1;

  return (
    <Box ref={rootRef} sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, flex: 1 }}>
      <NotebookToolbar
        path={state.path}
        dirty={state.dirty}
        running={state.running}
        canRun={canRun}
        timer={{ current: state.current, lastRun: state.lastRun, total: totalElapsed(state), cells: cells.length }}
        onRunAll={() => run(null)}
        onInterrupt={stop}
        onRestart={nb.restart}
        onRestartAndClear={nb.restartAndClear}
        onRestartAndRunAll={nb.restartAndRunAll}
        onClearOutputs={() => clearOutputs(null)}
        onShowSetup={setup ? () => setSetupOpen(true) : undefined}
        autorun={nb.autorun}
        onAutorun={nb.setAutorun}
        onToggleSide={() => {
          setOutlineOpen(!outlineShown);
          setIaraOpen(false);
        }}
        sideOpen={outlineShown}
        onToggleIara={() => {
          setOutlineOpen(false);
          setIaraOpen(!iaraOpen);
        }}
        iaraOpen={iaraOpen}
        onOutputs={(hide) => outputs.setHidden(hide ? new Set(cells.map((c) => c.id)) : new Set())}
        fileMenu={<FileActionsMenu path={state.path} kind="notebook" cells={state.cells} />}
        cluster={<NotebookClusterSelect path={state.path} onCluster={setClusterId} onAttached={nb.reset} />}
      />
      <WidgetBar widgets={state.widgets} onChange={setWidget} />
      {failure && (
        <Alert
          severity="warning"
          sx={{ borderRadius: 0, py: 0, flexShrink: 0, alignItems: "center" }}
          action={
            <Button color="inherit" size="small" onClick={() => setSetupOpen(true)}>
              Show setup code
            </Button>
          }
        >
          Setup code failed: {failure}
        </Alert>
      )}
      <SetupDialog
        open={setupOpen}
        path={state.path}
        cell={setup}
        error={failure}
        running={state.running}
        canRun={canRun}
        onClose={() => setSetupOpen(false)}
        onSave={saveSetup}
        onRun={runSetup}
      />
      <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>
        <Box sx={{ position: "relative", display: "flex", flex: 1, minWidth: 0 }}>
          <Box ref={setScrollEl} sx={{ flex: 1, overflow: "auto", px: { xs: 1, md: 4 }, py: 2 }}>
            <FindBar find={find} />
            <Box sx={{ maxWidth: 1180, mx: "auto" }}>
              <AddCellBar onAdd={(k) => addAt(0, k)} persistent={cells.length === 0} />
              <FindContext.Provider value={findContext}>
                <CellList cells={cells} onReorder={nb.reorder}>
                  {cells.map((cell, i) => (
                    <Fragment key={cell.id}>
                      {i === at && ghost}
                      <SortableCell
                        index={i}
                        last={i === last}
                        onAddAt={addAt}
                        path={state.path}
                        cell={cell}
                        state={state.states[cell.id] ?? IDLE}
                        stale={isStale(state, cell)}
                        progress={state.progress[cell.id]}
                        kernelKey={nb.kernelKey}
                        running={state.running}
                        settled={!state.running && !state.dirty}
                        canRun={canRun}
                        stopping={stopping}
                        schema={completionSchema}
                        outputHidden={outputs.hidden.has(cell.id)}
                        autoFocus={cell.id === fresh}
                        review={iara.review?.change.action === "edit_cell" && iara.review.cellId === cell.id ? iara.review : undefined}
                        onEdit={nb.edit}
                        onRun={runOne}
                        onStop={stop}
                        onSave={nb.save}
                        onMove={nb.move}
                        onDelete={nb.remove}
                        onToggleOutput={outputs.toggle}
                        onClearOutput={clearOne}
                        onCopyLink={copyLink}
                      />
                    </Fragment>
                  ))}
                  {at === cells.length && ghost}
                </CellList>
              </FindContext.Provider>
            </Box>
          </Box>
          <RunPanel current={state.current} lastRun={state.lastRun} cells={cells} states={state.states} progress={state.progress} rootRef={rootRef} />
        </Box>
        {outlineShown && <NotebookSidePanel cells={cells} variables={variables} scrollRoot={scrollEl} />}
        {iaraOpen && (
          <IaraPanel fileId={fileIdOf(state.path) ?? state.path} surface="notebook" getContext={iara.getContext} adapter={iara.adapter} onClose={() => setIaraOpen(false)} />
        )}
      </Box>
    </Box>
  );
}
