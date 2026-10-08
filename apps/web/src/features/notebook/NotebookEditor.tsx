"use client";

import Box from "@mui/material/Box";
import type { CellKind, NotebookView, Variable } from "@workhouse/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";

import { NotebookClusterSelect } from "@/features/compute/NotebookClusterSelect";
import { DeleteEntryDialog } from "@/features/files/DeleteEntryDialog";
import { notebookVariables } from "@/server/actions/notebooks";

import { AddCellBar } from "./AddCellBar";
import { CellList } from "./CellList";
import { IDLE, isStale, totalElapsed } from "./notebookState";
import { NotebookToolbar } from "./NotebookToolbar";
import { SortableCell } from "./SortableCell";
import { useNotebook } from "./useNotebook";
import { VariablesPanel } from "./VariablesPanel";

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
  const [showVars, setShowVars] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [variables, setVariables] = useState<Variable[]>([]);
  const refreshVariables = useCallback(async () => {
    const r = await notebookVariables(initial.path);
    if (r.ok) setVariables(r.data);
  }, [initial.path]);
  const nb = useNotebook(initial, refreshVariables);
  const { state, run, addCell } = nb;
  const outputs = useHiddenOutputs();
  const completionSchema = useMemo(() => sqlSchema(schema, variables), [schema, variables]);

  useEffect(() => {
    void refreshVariables();
  }, [refreshVariables]);

  const runOne = useCallback((id: string) => run([id]), [run]);
  // the cell just added takes the focus
  const [fresh, setFresh] = useState<string | null>(null);
  const addAt = useCallback((index: number, kind: CellKind) => setFresh(addCell(index, kind).id), [addCell]);
  const last = state.cells.length - 1;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, flex: 1 }}>
      <NotebookToolbar
        path={state.path}
        dirty={state.dirty}
        running={state.running}
        timer={{ current: state.current, lastRun: state.lastRun, total: totalElapsed(state), cells: state.cells.length }}
        onRunAll={() => run(null)}
        onInterrupt={nb.interrupt}
        onRestart={nb.restart}
        onToggleVariables={() => setShowVars((v) => !v)}
        onOutputs={(hide) => outputs.setHidden(hide ? new Set(state.cells.map((c) => c.id)) : new Set())}
        onDelete={() => setDeleting(true)}
        cluster={<NotebookClusterSelect path={state.path} onAttached={nb.reset} />}
      />
      <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>
        <Box sx={{ flex: 1, overflow: "auto", px: { xs: 1, md: 4 }, py: 2 }}>
          <Box sx={{ maxWidth: 1180, mx: "auto" }}>
            <AddCellBar onAdd={(k) => addAt(0, k)} persistent={state.cells.length === 0} />
            <CellList cells={state.cells} onReorder={nb.reorder}>
              {state.cells.map((cell, i) => (
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
                />
              ))}
            </CellList>
          </Box>
        </Box>
        {showVars && <VariablesPanel variables={variables} />}
      </Box>
      <DeleteEntryDialog path={deleting ? state.path : null} onClose={() => setDeleting(false)} />
    </Box>
  );
}
