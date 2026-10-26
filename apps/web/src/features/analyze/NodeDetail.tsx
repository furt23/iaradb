"use client";

import CloseRounded from "@mui/icons-material/CloseRounded";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import type { AnalyzedNode } from "@iara/protocol";

import { operatorColor } from "@/features/results/operators";

import { metricRows, timeShare } from "./metrics";

interface Props {
  node: AnalyzedNode;
  totalMs: number;
  onClose(): void;
}

/** An operator's full detail and metrics, in a panel beside the graph. */
export function NodeDetail({ node, totalMs, onClose }: Props) {
  return (
    <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 1.5, minHeight: 0, overflow: "auto", borderLeft: 1, borderColor: "divider" }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, color: operatorColor(node.name), minWidth: 0, overflowWrap: "anywhere" }}>
          {node.name}
        </Typography>
        {node.role && (
          <Typography variant="mono" sx={{ fontSize: 11, textTransform: "uppercase", color: "text.secondary", border: 1, borderColor: "divider", borderRadius: 0.75, px: 0.75 }}>
            {node.role}
          </Typography>
        )}
        <IconButton size="small" aria-label="close" onClick={onClose} sx={{ ml: "auto" }}>
          <CloseRounded fontSize="small" />
        </IconButton>
      </Box>
      <Typography variant="mono" component="pre" sx={{ m: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 11.5, color: "text.secondary" }}>
        {node.detail}
      </Typography>
      {node.metrics && (
        <Box sx={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 1, columnGap: 3, alignItems: "baseline" }}>
          {metricRows(node.metrics, timeShare(node, totalMs)).map(([label, value]) => (
            <Box key={label} sx={{ display: "contents" }}>
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                {label}
              </Typography>
              <Typography variant="mono" sx={{ textAlign: "right", justifySelf: "end" }}>
                {value}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
