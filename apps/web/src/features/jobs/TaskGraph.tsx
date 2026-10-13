"use client";

import Box from "@mui/material/Box";
import { alpha, useTheme } from "@mui/material/styles";
import { useId, type KeyboardEvent } from "react";

import { DAG_NODE, layoutDag } from "@/lib/dagLayout";
import type { TaskRun, TaskRunStatus, TaskSpec } from "@/lib/jobs";
import { baseName } from "@/lib/paths";

import { statusTone, type StatusTone } from "./taskStatus";

const PAD = 8;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * A job's tasks as a graph, left to right, an arrow from a task to the tasks
 * that wait for it. With a run, each task takes the colour of its status.
 * Wider than its box: it scrolls.
 */
export function TaskGraph({
  tasks,
  run,
  selected,
  onSelect,
  scale = 1,
}: {
  tasks: TaskSpec[];
  /** the tasks of a run: colours the boxes by status (tasks it lacks are pending) */
  run?: TaskRun[] | null;
  selected?: string | null;
  onSelect?(key: string): void;
  /** 1: full size */
  scale?: number;
}) {
  const theme = useTheme();
  const marker = `arrow${useId().replace(/[^A-Za-z0-9]/g, "")}`;
  const layout = layoutDag(tasks);
  if (!layout.nodes.length) return null;

  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const statusOf = new Map<string, TaskRunStatus>((run ?? []).map((t) => [t.key, t.status]));
  const pos = new Map(layout.nodes.map((n) => [n.key, n]));
  const edgeColor = theme.palette.text.disabled;

  const tone = (key: string): StatusTone => (run ? statusTone(statusOf.get(key) ?? "pending") : "muted");
  const color = (t: StatusTone) => (t === "muted" ? theme.palette.text.secondary : theme.palette[t].main);
  const w = layout.width + PAD * 2;
  const h = layout.height + PAD * 2;
  const pick = onSelect;

  return (
    <Box sx={{ overflowX: "auto", overflowY: "hidden" }}>
      <svg role="group" aria-label="task graph" width={w * scale} height={h * scale} viewBox={`0 0 ${w} ${h}`} style={{ display: "block", minWidth: w * scale }}>
        <defs>
          <marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0 L10 5 L0 10 z" fill={edgeColor} />
          </marker>
        </defs>
        {layout.edges.map((e) => {
          const a = pos.get(e.from)!;
          const b = pos.get(e.to)!;
          const x1 = PAD + a.x + DAG_NODE.width;
          const y1 = PAD + a.y + DAG_NODE.height / 2;
          const x2 = PAD + b.x;
          const y2 = PAD + b.y + DAG_NODE.height / 2;
          const mid = (x1 + x2) / 2;
          return <path key={`${e.from}>${e.to}`} d={`M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2 - 1} ${y2}`} fill="none" stroke={edgeColor} strokeWidth={1.5} markerEnd={`url(#${marker})`} />;
        })}
        {layout.nodes.map((n) => {
          const task = byKey.get(n.key)!;
          const status = run ? (statusOf.get(n.key) ?? "pending") : null;
          const t = tone(n.key);
          const c = color(t);
          const isSelected = selected === n.key;
          const dashed = status === "skipped" || status === "upstream_failed";
          const key = (e: KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              pick?.(n.key);
            }
          };
          return (
            <g
              key={n.key}
              transform={`translate(${PAD + n.x} ${PAD + n.y})`}
              role={pick ? "button" : undefined}
              tabIndex={pick ? 0 : undefined}
              aria-label={`task ${n.key}${status ? ` ${status}` : ""}`}
              aria-pressed={pick ? isSelected : undefined}
              onClick={pick ? () => pick(n.key) : undefined}
              onKeyDown={pick ? key : undefined}
              style={{ cursor: pick ? "pointer" : "default", outline: "none" }}
            >
              <title>{`${n.key}: ${task.target}${status ? ` (${status})` : ""}`}</title>
              <rect
                width={DAG_NODE.width}
                height={DAG_NODE.height}
                rx={10}
                fill={t === "muted" ? theme.palette.background.paper : alpha(c, 0.12)}
                stroke={isSelected ? theme.palette.secondary.main : t === "muted" ? theme.palette.divider : c}
                strokeWidth={isSelected ? 2.5 : 1.5}
                strokeDasharray={dashed ? "5 4" : undefined}
              />
              {status === "running" || status === "starting" ? <circle cx={DAG_NODE.width - 14} cy={14} r={4} fill={c} /> : null}
              <text x={14} y={24} fontSize={13} fontWeight={650} fill={theme.palette.text.primary} fontFamily={theme.typography.fontFamily}>
                {clip(n.key, 24)}
              </text>
              <text x={14} y={42} fontSize={11.5} fill={theme.palette.text.secondary} fontFamily={theme.typography.fontFamily}>
                {clip(baseName(task.target), 28)}
              </text>
            </g>
          );
        })}
      </svg>
    </Box>
  );
}
