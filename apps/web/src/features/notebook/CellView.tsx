"use client";

import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Paper from "@mui/material/Paper";
import type { Cell, CellKind, CellState, ChartSpec, QueryProfile } from "@iara/protocol";
import { memo, useMemo, useState } from "react";

import { CodeEditor } from "@/features/editor/CodeEditor";
import { Markdown, OutputView, Streams } from "@/features/results/OutputView";
import { LiveProgress } from "@/features/results/ProfileView";

import { cellAssist } from "./cellAssist";
import { CellHeader } from "./CellHeader";
import { FrameList } from "./FrameList";
import { statusColor } from "./CellStatus";
import type { DragHandle } from "./SortableCell";

export interface CellViewProps {
  /** notebook path (code assistance runs in its kernel) */
  path: string;
  cell: Cell;
  state: CellState;
  stale: boolean;
  progress?: QueryProfile[];
  kernelKey: string;
  running: boolean;
  schema: Record<string, { name: string }[]>;
  outputHidden: boolean;
  /** a cell just added: its editor takes the focus */
  autoFocus?: boolean;
  dragHandle?: DragHandle;
  onEdit(id: string, patch: Partial<Pick<Cell, "code" | "kind" | "output" | "config">>): void;
  onRun(id: string): void;
  onSave(): void;
  onMove(id: string, delta: -1 | 1): void;
  onDelete(id: string): void;
  onToggleOutput(id: string): void;
  onClearOutput(id: string): void;
  onCopyLink(id: string): void;
}

const PLACEHOLDER: Record<CellKind, string> = {
  python: "Python: values defined here are visible to other cells",
  sql: "select * from my_table  -- catalog tables and DataFrames from other cells",
  markdown: "Markdown text",
};

function MarkdownBody({ cell, editing, setEditing, onChange, onRun }: { cell: Cell; editing: boolean; setEditing(v: boolean): void; onChange(v: string): void; onRun(): void }) {
  if (!editing && cell.code.trim()) {
    return (
      <Box onDoubleClick={() => setEditing(true)} sx={{ cursor: "text", minHeight: 32 }} title="Double-click to edit">
        <Markdown text={cell.code} />
      </Box>
    );
  }
  return (
    <Box onBlur={() => cell.code.trim() && setEditing(false)}>
      <CodeEditor value={cell.code} onChange={onChange} language="markdown" autoFocus={editing} lineNumbers={false} placeholder={PLACEHOLDER.markdown} onRun={() => (setEditing(false), onRun())} />
    </Box>
  );
}

function HiddenOutput({ onShow }: { onShow(): void }) {
  return (
    <ButtonBase onClick={onShow} sx={{ width: "100%", justifyContent: "flex-start", px: 2, py: 0.5, fontSize: 12, color: "text.disabled", "&:hover": { color: "text.secondary" } }}>
      Output hidden · show
    </ButtonBase>
  );
}

function CellViewImpl(p: CellViewProps) {
  const { cell, state } = p;
  const [editingMd, setEditingMd] = useState(!!p.autoFocus);
  const assist = useMemo(() => cellAssist(p.path, cell.id, cell.kind), [p.path, cell.id, cell.kind]);
  const hidden = cell.config.hide_code === true;
  const run = () => p.onRun(cell.id);
  const onChange = (code: string) => p.onEdit(cell.id, { code });
  const border = statusColor(state.status, p.stale);
  const frames = state.frames ?? [];
  const hasOutput = state.streams.length > 0 || frames.length > 0 || (!!state.output && cell.kind !== "markdown");

  return (
    <Paper
      variant="outlined"
      data-cell-id={cell.id}
      sx={{ overflow: "hidden", borderLeft: 3, borderLeftColor: border === "transparent" ? "divider" : border, transition: "border-color 120ms" }}
    >
      <CellHeader
        cell={cell}
        state={state}
        stale={p.stale}
        disabled={false}
        hidden={hidden}
        hasOutput={hasOutput}
        outputHidden={p.outputHidden}
        dragHandle={p.dragHandle}
        onRun={run}
        onKind={(kind) => p.onEdit(cell.id, { kind, output: kind === "sql" ? (cell.output ?? "df") : cell.output })}
        onOutput={(output) => p.onEdit(cell.id, { output })}
        onMove={(d) => p.onMove(cell.id, d)}
        onToggleHidden={() => p.onEdit(cell.id, { config: { ...cell.config, hide_code: !hidden } })}
        onToggleOutput={() => p.onToggleOutput(cell.id)}
        onClearOutput={() => p.onClearOutput(cell.id)}
        onCopyLink={() => p.onCopyLink(cell.id)}
        onDelete={() => p.onDelete(cell.id)}
      />
      {!hidden && cell.kind === "markdown" && <MarkdownBody cell={cell} editing={editingMd} setEditing={setEditingMd} onChange={onChange} onRun={run} />}
      {!hidden && cell.kind !== "markdown" && (
        <Box sx={{ borderTop: 1, borderColor: "divider" }}>
          <CodeEditor
            value={cell.code}
            onChange={onChange}
            language={cell.kind}
            schema={cell.kind === "sql" ? p.schema : undefined}
            assist={assist}
            autoFocus={p.autoFocus}
            onRun={run}
            onRunInPlace={run}
            onSave={p.onSave}
            placeholder={PLACEHOLDER[cell.kind]}
          />
        </Box>
      )}
      {state.status === "running" && p.progress && <LiveProgress queries={p.progress} />}
      {hasOutput && (
        <Box sx={{ borderTop: 1, borderColor: "divider", bgcolor: "background.default" }}>
          {p.outputHidden ? (
            <HiddenOutput onShow={() => p.onToggleOutput(cell.id)} />
          ) : (
            <>
              <FrameList frames={frames} />
              <Streams streams={state.streams} />
              {state.output && state.output.type !== "markdown" && (
                <OutputView
                  output={state.output}
                  kernelKey={p.kernelKey}
                  // the chart is saved with the cell (a marimo decorator option)
                  chart={(cell.config.chart as ChartSpec | undefined) ?? null}
                  onChart={(chart) => p.onEdit(cell.id, { config: { ...cell.config, chart } })}
                />
              )}
            </>
          )}
        </Box>
      )}
    </Paper>
  );
}

export const CellView = memo(CellViewImpl);
