"use client";

import CloseRounded from "@mui/icons-material/CloseRounded";
import ExpandLess from "@mui/icons-material/ExpandLess";
import ExpandMore from "@mui/icons-material/ExpandMore";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import type { Cell, CellState, QueryProfile } from "@iara/protocol";
import { type RefObject, useEffect, useRef, useState } from "react";

import { formatDuration } from "@/lib/format";

import { CellStatusBadge } from "./CellStatus";
import type { RunProgress, RunSummary } from "./notebookState";
import { type RunRow, runRows } from "./runRows";
import { useNow } from "./RunTimer";
import { reveal } from "./useCellAnchor";

const ENDED = new Set(["done", "error", "cancelled"]);

function Row({ row, onClick }: { row: RunRow; onClick(): void }) {
  const running = row.status === "running";
  const ref = useRef<HTMLButtonElement>(null);
  // the panel follows the run down its list
  useEffect(() => {
    if (running) ref.current?.scrollIntoView({ block: "nearest" });
  }, [running]);
  return (
    <ButtonBase
      ref={ref}
      onClick={onClick}
      title={`Cell ${row.number}: go to it`}
      sx={{
        display: "grid",
        gridTemplateColumns: "24px minmax(0, 1fr) auto",
        columnGap: 1,
        alignItems: "center",
        width: "100%",
        textAlign: "left",
        px: 1.25,
        py: 0.5,
        bgcolor: running ? "action.selected" : undefined,
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      <Typography variant="mono" sx={{ fontSize: 11, color: "text.disabled", textAlign: "right" }}>
        {row.number}
      </Typography>
      <Typography
        variant="mono"
        sx={{ fontSize: 11.5, color: row.status === "queued" ? "text.disabled" : "text.primary", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
      >
        {row.preview || "(empty)"}
      </Typography>
      <CellStatusBadge status={row.status} stale={false} elapsed={row.elapsed} />
      {row.query && (
        <Box sx={{ gridColumn: "2 / 4", display: "flex", alignItems: "center", gap: 1, mt: 0.5 }}>
          <LinearProgress variant="determinate" value={row.query.share * 100} sx={{ flex: 1, height: 3, borderRadius: 2 }} />
          <Typography variant="mono" sx={{ fontSize: 10.5, color: "text.secondary", whiteSpace: "nowrap" }}>
            {Math.floor(row.query.share * 100)}% · pipeline {row.query.pipeline}/{row.query.pipelines}
          </Typography>
        </Box>
      )}
    </ButtonBase>
  );
}

interface Props {
  current: RunProgress | null;
  lastRun: RunSummary | null;
  cells: Cell[];
  states: Record<string, CellState>;
  progress: Record<string, QueryProfile[]>;
  /** the element holding the cells */
  rootRef: RefObject<HTMLElement | null>;
}

/**
 * A card at the side of the notebook while it runs several cells: each cell of
 * the run with its number, state and time and, for the one running, how far its
 * query is. A click scrolls to the cell. Once the run ends it stays with the
 * final states, until closed or the next run.
 */
export function RunPanel({ current, lastRun, cells, states, progress, rootRef }: Props) {
  const color = useTheme().palette.primary.main;
  const [run, setRun] = useState<{ startedAt: number; queued: string[] } | null>(null);
  const [closed, setClosed] = useState<number | null>(null);
  const [folded, setFolded] = useState(false);
  useEffect(() => {
    // a single cell run from its editor needs no panel
    if (current && current.queued.length > 1) setRun({ startedAt: current.startedAt, queued: current.queued });
  }, [current]);
  const live = !!run && current?.startedAt === run.startedAt;
  const now = useNow(live, 500);
  if (!run || run.startedAt === closed) return null;

  // once the run is over, a cell it never finished (its state lost to a kernel restart) did not run
  const rows = runRows(run.queued, cells, states, progress).map((r) => (live || ENDED.has(r.status) ? r : { ...r, status: "cancelled" as const, query: undefined }));
  const ended = rows.filter((r) => ENDED.has(r.status)).length;
  const failed = rows.filter((r) => r.status === "error").length;
  const ms = live ? now - run.startedAt : lastRun?.startedAt === run.startedAt ? lastRun.finishedAt - lastRun.startedAt : null;
  const summary = [`${ended}/${rows.length} cells`, failed ? `${failed} failed` : null, ms == null ? null : formatDuration(ms)].filter(Boolean).join(" · ");

  return (
    <Paper
      elevation={6}
      role="region"
      aria-label="notebook run"
      sx={{ position: "absolute", top: 12, right: 16, zIndex: 2, width: 280, maxHeight: "calc(100% - 24px)", display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, pl: 1.5, pr: 0.5, py: 0.5, borderBottom: folded ? 0 : 1, borderColor: "divider" }}>
        <Typography variant="body2" sx={{ fontWeight: 650 }}>
          {live ? "Running" : "Run"}
        </Typography>
        <Typography variant="mono" sx={{ fontSize: 11, color: failed ? "error.main" : "text.secondary", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {summary}
        </Typography>
        <IconButton size="small" aria-label={folded ? "show the cells" : "hide the cells"} onClick={() => setFolded((f) => !f)} sx={{ ml: "auto" }}>
          {folded ? <ExpandMore fontSize="small" /> : <ExpandLess fontSize="small" />}
        </IconButton>
        <IconButton size="small" aria-label="close" onClick={() => setClosed(run.startedAt)}>
          <CloseRounded fontSize="small" />
        </IconButton>
      </Box>
      {!folded && (
        <Box sx={{ overflowY: "auto", py: 0.25 }}>
          {rows.map((r) => (
            <Row key={r.id} row={r} onClick={() => rootRef.current && reveal(rootRef.current, r.id, color)} />
          ))}
        </Box>
      )}
    </Paper>
  );
}
