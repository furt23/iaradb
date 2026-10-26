"use client";

import Box from "@mui/material/Box";
import LinearProgress from "@mui/material/LinearProgress";
import { alpha } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import type { AnalyzedNode } from "@iara/protocol";

import { operatorColor } from "@/features/results/operators";
import { formatCount, formatDuration } from "@/lib/format";

import { BOX, type Placed } from "./layout";
import { heat, timeShare } from "./metrics";

interface Props {
  placed: Placed<AnalyzedNode>;
  /** the space around the graph */
  margin: number;
  totalMs: number;
  hottestMs: number;
  onOpen(node: AnalyzedNode): void;
}

/** An operator: its name, detail and role and, when measured, its rows, time and share of the run. */
export function PlanNodeBox({ placed, margin, totalMs, hottestMs, onOpen }: Props) {
  const { node } = placed;
  const color = operatorColor(node.name);
  const tint = heat(node, hottestMs);
  return (
    <Box
      component="button"
      type="button"
      onClick={() => onOpen(node)}
      sx={{
        position: "absolute",
        left: placed.left + margin,
        top: placed.top + margin,
        width: BOX.width,
        height: BOX.height,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: 0.25,
        px: 1,
        py: 0.75,
        m: 0,
        overflow: "hidden",
        textAlign: "left",
        font: "inherit",
        color: "text.primary",
        cursor: "pointer",
        borderRadius: 1.5,
        border: 1,
        borderColor: "divider",
        borderLeft: 3,
        borderLeftColor: color,
        bgcolor: alpha(color, 0.05 + 0.25 * tint),
        "&:hover, &:focus-visible": { borderColor: color, outline: "none" },
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
        <Typography component="span" sx={{ fontWeight: 700, fontSize: 12, lineHeight: 1.3, color, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
          {node.name}
        </Typography>
        {node.role && (
          <Typography component="span" variant="mono" sx={{ ml: "auto", flexShrink: 0, fontSize: 10, textTransform: "uppercase", color: "text.secondary", border: 1, borderColor: "divider", borderRadius: 0.75, px: 0.5 }}>
            {node.role}
          </Typography>
        )}
      </Box>
      <Typography variant="mono" title={node.detail} sx={{ fontSize: 10.5, lineHeight: 1.3, color: "text.secondary", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {node.detail === node.name ? "" : node.detail}
      </Typography>
      {node.metrics && (
        <Box sx={{ mt: "auto" }}>
          <Typography variant="mono" sx={{ display: "block", fontSize: 11, lineHeight: 1.3, whiteSpace: "nowrap" }}>
            {formatCount(node.metrics.rows_out)} rows · {formatDuration(node.metrics.elapsed_ms)}
          </Typography>
          <LinearProgress
            variant="determinate"
            value={timeShare(node, totalMs) * 100}
            sx={{ height: 3, borderRadius: 2, mt: 0.5, "& .MuiLinearProgress-bar": { bgcolor: color } }}
          />
        </Box>
      )}
    </Box>
  );
}
