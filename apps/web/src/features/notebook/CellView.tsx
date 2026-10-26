"use client";

import StopCircleOutlined from "@mui/icons-material/StopCircleOutlined";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Paper from "@mui/material/Paper";
import type { Cell, CellKind, CellState, ChartSpec, QueryProfile } from "@iara/protocol";
import { memo, useMemo, useState } from "react";

import { CodeEditor } from "@/features/editor/CodeEditor";
import { ReviewBar } from "@/features/iara/ReviewBar";
import { Markdown, OutputView, Streams } from "@/features/results/OutputView";
import { LiveProgress } from "@/features/results/ProfileView";

import { cellAssist } from "./cellAssist";
import { CellHeader } from "./CellHeader";
import { CellPipelines } from "./CellPipelines";
import { FrameList } from "./FrameList";
import type { NotebookReview } from "./iaraBridge";
import { statusColor } from "./CellStatus";
import { PlanWindow } from "./PlanWindow";
import type { DragHandle } from "./SortableCell";

export interface CellViewProps {
  /** notebook path (code assistance runs in its kernel) */
  path: string;
  cell: Cell;
  state: CellState;
  stale: boolean;
  progress?: QueryProfile[];
  kernelKey: string;
  /** the notebook runs (any of its cells) */
  running: boolean;
  /** the notebook is saved and not running: other cells' names and values are as the kernel has them */
  settled: boolean;
  /** the notebook's cluster runs: a cell can be run only then */
  canRun: boolean;
  /** a stop was asked for and the run has not ended yet */
  stopping: boolean;
  schema: Record<string, { name: string }[]>;
  outputHidden: boolean;
  /** a cell just added: its editor takes the focus */
  autoFocus?: boolean;
  /** a change Iara proposes to this cell, shown as a diff until the user keeps or undoes it */
  review?: NotebookReview;
  dragHandle?: DragHandle;
  onEdit(id: string, patch: Partial<Pick<Cell, "code" | "kind" | "output" | "config">>): void;
  onRun(id: string): void;
  /** stop the whole run */
  onStop(): void;
  onSave(): void;
  onMove(id: string, delta: -1 | 1): void;
  onDelete(id: string): void;
  onToggleOutput(id: string): void;
  onClearOutput(id: string): void;
  onCopyLink(id: string): void;
}

const PLACEHOLDER: Partial<Record<CellKind, string>> = {
  sql: "select * from my_table",
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

/** Where an error would show: the run was stopped by the user, which is not one. */
function Stopped() {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, px: 1.5, py: 0.5, borderTop: 1, borderColor: "divider", fontSize: 12, color: "text.secondary" }}>
      <StopCircleOutlined sx={{ fontSize: 16, color: "warning.main" }} />
      Execution stopped
    </Box>
  );
}

function CellViewImpl(p: CellViewProps) {
  const { cell, state } = p;
  const [editingMd, setEditingMd] = useState(!!p.autoFocus);
  // the plan window, and what it opens on
  const [plans, setPlans] = useState<{ query: number; pipeline?: number } | null>(null);
  const assist = useMemo(() => cellAssist(p.path, cell.id, cell.kind), [p.path, cell.id, cell.kind]);
  const hidden = cell.config.hide_code === true;
  const run = () => p.onRun(cell.id);
  const onChange = (code: string) => p.onEdit(cell.id, { code });
  const review = p.review;
  const keep = () => review?.decide.keep(p.canRun);
  const border = statusColor(state.status, p.stale);
  const frames = state.frames ?? [];
  const queries = state.queries ?? [];
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
        running={p.running}
        canRun={p.canRun}
        stopping={p.stopping}
        onStop={p.onStop}
        hidden={hidden}
        hasOutput={hasOutput}
        outputHidden={p.outputHidden}
        dragHandle={p.dragHandle}
        onRun={run}
        onKind={(kind) => p.onEdit(cell.id, { kind, output: kind === "sql" ? (cell.output ?? "df") : cell.output })}
        onOutput={(output) => p.onEdit(cell.id, { output })}
        onPlans={() => setPlans({ query: queries.length - 1 })}
        onMove={(d) => p.onMove(cell.id, d)}
        onToggleHidden={() => p.onEdit(cell.id, { config: { ...cell.config, hide_code: !hidden } })}
        onToggleOutput={() => p.onToggleOutput(cell.id)}
        onClearOutput={() => p.onClearOutput(cell.id)}
        onCopyLink={() => p.onCopyLink(cell.id)}
        onDelete={() => p.onDelete(cell.id)}
      />
      {!review && !hidden && cell.kind === "markdown" && <MarkdownBody cell={cell} editing={editingMd} setEditing={setEditingMd} onChange={onChange} onRun={run} />}
      {/* a change Iara proposes shows even for a markdown cell or hidden code; a code cell keeps its editor, so Ctrl+Z after keeping it brings the old code back */}
      {(review || (!hidden && cell.kind !== "markdown")) && (
        <Box sx={{ borderTop: 1, borderColor: "divider" }}>
          {review && <ReviewBar decide={review.decide} canRun={p.canRun} />}
          <CodeEditor
            value={review ? review.code : cell.code}
            original={review?.original}
            onChange={review ? review.setCode : onChange}
            language={cell.kind}
            schema={cell.kind === "sql" ? p.schema : undefined}
            assist={assist}
            relint={p.settled}
            autoFocus={p.autoFocus}
            onRun={review ? keep : run}
            onRunInPlace={review ? keep : run}
            onSave={p.onSave}
            placeholder={PLACEHOLDER[cell.kind]}
          />
        </Box>
      )}
      {state.status === "running" && p.progress && <LiveProgress queries={p.progress} />}
      {state.status !== "running" && queries.length > 0 && <CellPipelines queries={queries} onOpen={(query, pipeline) => setPlans({ query, pipeline })} />}
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
      {state.status === "cancelled" && !state.output && <Stopped />}
      {plans && queries.length > 0 && (
        // keyed: picking another pipeline opens the window on it
        <PlanWindow key={`${plans.query}:${plans.pipeline}`} queries={queries} opening={plans} onClose={() => setPlans(null)} />
      )}
    </Paper>
  );
}

export const CellView = memo(CellViewImpl);
