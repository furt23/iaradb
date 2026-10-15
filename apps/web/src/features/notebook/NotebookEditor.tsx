"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import type { CellKind, NotebookView, Variable } from "@workhouse/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { NotebookClusterSelect } from "@/features/compute/NotebookClusterSelect";
import { useNotify } from "@/features/shell/notify";
import { FileActionsMenu } from "@/features/workbench/FileActionsMenu";
import { notebookVariables } from "@/server/actions/notebooks";

import { AddCellBar } from "./AddCellBar";
import { CellList } from "./CellList";
import { IDLE, isStale, setupCell, setupError, totalElapsed, visibleCells } from "./notebookState";
import { NotebookSidePanel } from "./NotebookSidePanel";
import { NotebookToolbar } from "./NotebookToolbar";
import { SetupDialog } from "./SetupDialog";
import { WidgetBar } from "./WidgetBar";
import { SortableCell } from "./SortableCell";
import { cellLink, useCellAnchor } from "./useCellAnchor";
import { useNotebook } from "./useNotebook";

type Schema = Record<string, { name: string }[]>;

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
  const [showSide, setShowSide] = useState(false);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const [variables, setVariables] = useState<Variable[]>([]);
  const refreshVariables = useCallback(async () => {
    const r = await notebookVariables(initial.path);
    if (r.ok) setVariables(r.data);
  }, [initial.path]);
  const nb = useNotebook(initial, refreshVariables);
  const { state, run, addCell, clearOutputs, save } = nb;
  const notify = useNotify();
  const outputs = useHiddenOutputs();
  const completionSchema = useMemo(() => sqlSchema(schema, variables), [schema, variables]);

  useEffect(() => {
    void refreshVariables();
  }, [refreshVariables]);

  const runOne = useCallback((id: string) => run([id]), [run]);
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
  // the cell just added takes the focus
  const [fresh, setFresh] = useState<string | null>(null);
  const addAt = useCallback((index: number, kind: CellKind) => setFresh(addCell(index, kind).id), [addCell]);
  // the setup cell is edited in its dialog: the list, the outline and every index below are those of the visible cells
  const cells = useMemo(() => visibleCells(state.cells), [state.cells]);
  const setup = useMemo(() => setupCell(state.cells), [state.cells]);
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
  const last = cells.length - 1;

  return (
    <Box ref={rootRef} sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, flex: 1 }}>
      <NotebookToolbar
        path={state.path}
        dirty={state.dirty}
        running={state.running}
        timer={{ current: state.current, lastRun: state.lastRun, total: totalElapsed(state), cells: cells.length }}
        onRunAll={() => run(null)}
        onInterrupt={nb.interrupt}
        onRestart={nb.restart}
        onRestartAndClear={nb.restartAndClear}
        onRestartAndRunAll={nb.restartAndRunAll}
        onClearOutputs={() => clearOutputs(null)}
        onShowSetup={setup ? () => setSetupOpen(true) : undefined}
        autorun={nb.autorun}
        onAutorun={nb.setAutorun}
        onToggleSide={() => setShowSide((v) => !v)}
        sideOpen={showSide}
        onOutputs={(hide) => outputs.setHidden(hide ? new Set(cells.map((c) => c.id)) : new Set())}
        fileMenu={<FileActionsMenu path={state.path} kind="notebook" cells={state.cells} />}
        cluster={<NotebookClusterSelect path={state.path} onAttached={nb.reset} />}
      />
      <WidgetBar widgets={state.widgets} onChange={nb.setWidget} />
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
        onClose={() => setSetupOpen(false)}
        onSave={saveSetup}
        onRun={runSetup}
      />
      <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>
        <Box ref={setScrollEl} sx={{ flex: 1, overflow: "auto", px: { xs: 1, md: 4 }, py: 2 }}>
          <Box sx={{ maxWidth: 1180, mx: "auto" }}>
            <AddCellBar onAdd={(k) => addAt(0, k)} persistent={cells.length === 0} />
            <CellList cells={cells} onReorder={nb.reorder}>
              {cells.map((cell, i) => (
                <SortableCell
                  key={cell.id}
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
                  schema={completionSchema}
                  outputHidden={outputs.hidden.has(cell.id)}
                  autoFocus={cell.id === fresh}
                  onEdit={nb.edit}
                  onRun={runOne}
                  onSave={nb.save}
                  onMove={nb.move}
                  onDelete={nb.remove}
                  onToggleOutput={outputs.toggle}
                  onClearOutput={clearOne}
                  onCopyLink={copyLink}
                />
              ))}
            </CellList>
          </Box>
        </Box>
        {showSide && <NotebookSidePanel cells={cells} variables={variables} scrollRoot={scrollEl} />}
      </Box>
    </Box>
  );
}
