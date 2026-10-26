"use client";

import ChevronRight from "@mui/icons-material/ChevronRight";
import ExpandMore from "@mui/icons-material/ExpandMore";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import type { QueryAnalysis } from "@iara/protocol";
import { useState } from "react";

import { PipelineLines } from "@/features/results/PipelineLines";
import { pipelineLines } from "@/features/results/progress";
import { formatDuration } from "@/lib/format";

const MONO = "'JetBrains Mono Variable', monospace";

interface Props {
  /** the queries of the cell's last run, oldest first */
  queries: QueryAnalysis[];
  /** open the graph of pipeline `pipeline` of query `query` */
  onOpen(query: number, pipeline: number): void;
}

/** Under a cell that ran queries: one line with what they ran, opening to a line per pipeline; a click opens its graph. */
export function CellPipelines({ queries, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  const pipelines = queries.reduce((n, q) => n + q.profile.pipelines.length, 0);
  const ms = queries.reduce((n, q) => n + q.profile.elapsed_ms, 0);
  const summary = [
    queries.length > 1 ? `${queries.length} queries` : null,
    `${pipelines} pipeline${pipelines === 1 ? "" : "s"}`,
    formatDuration(ms),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Box sx={{ borderTop: 1, borderColor: "divider" }}>
      <ButtonBase
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        sx={{ width: "100%", justifyContent: "flex-start", gap: 0.75, px: 1, py: 0.4, fontSize: 12, fontFamily: MONO, color: "text.secondary", "&:hover": { color: "text.primary" } }}
      >
        {open ? <ExpandMore sx={{ fontSize: 16 }} /> : <ChevronRight sx={{ fontSize: 16 }} />}
        {summary}
      </ButtonBase>
      {open && (
        <Box sx={{ pl: 4, pr: 1.5, pb: 0.75 }}>
          {queries.map((q, k) => (
            <Box key={k} sx={{ "& + &": { mt: 0.75 } }}>
              {queries.length > 1 && (
                <Typography variant="mono" sx={{ display: "block", fontSize: 11, color: "text.secondary", px: 0.5 }}>
                  Query {k + 1} · {formatDuration(q.profile.elapsed_ms)}
                </Typography>
              )}
              <PipelineLines lines={pipelineLines(q.profile)} onOpen={(i) => onOpen(k, i)} />
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
