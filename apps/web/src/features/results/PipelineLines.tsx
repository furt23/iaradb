"use client";

import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import LinearProgress from "@mui/material/LinearProgress";
import Typography from "@mui/material/Typography";

import { formatCount, formatDuration } from "@/lib/format";

import type { PipelineLine } from "./progress";

const ROW = { display: "grid", gridTemplateColumns: "64px 112px 72px", columnGap: 1.25, alignItems: "center", px: 0.5, py: 0.125, borderRadius: 1 } as const;

function Cells({ line, n }: { line: PipelineLine; n: number }) {
  const right = line.state === "done" ? formatDuration(line.ms) : line.state === "running" ? `${formatCount(line.done)}/${formatCount(line.total ?? 0)}` : "";
  return (
    <>
      <Typography variant="mono" sx={{ fontSize: 10.5, color: "inherit", fontWeight: line.state === "running" ? 650 : 400, whiteSpace: "nowrap" }}>
        Pipeline {n}
      </Typography>
      <LinearProgress
        variant="determinate"
        value={line.total ? (line.done / line.total) * 100 : 0}
        color={line.state === "done" ? "success" : "primary"}
        sx={{ height: 3, borderRadius: 2 }}
      />
      <Typography variant="mono" sx={{ fontSize: 10.5, color: "inherit", whiteSpace: "nowrap" }}>
        {right}
      </Typography>
    </>
  );
}

/** A query's pipelines as short lines in a corner, each with a small bar of how complete it is; with `onOpen`, a click opens one. */
export function PipelineLines({ lines, onOpen }: { lines: PipelineLine[]; onOpen?(index: number): void }) {
  return (
    <Box sx={{ width: "fit-content", maxHeight: 150, overflowY: "auto" }}>
      {lines.map((line, i) => {
        const color = line.state === "pending" ? "text.disabled" : line.state === "running" ? "text.primary" : "text.secondary";
        return onOpen ? (
          <ButtonBase key={i} onClick={() => onOpen(i)} sx={{ ...ROW, color, textAlign: "left", "&:hover": { bgcolor: "action.hover" } }}>
            <Cells line={line} n={i + 1} />
          </ButtonBase>
        ) : (
          <Box key={i} sx={{ ...ROW, color }}>
            <Cells line={line} n={i + 1} />
          </Box>
        );
      })}
    </Box>
  );
}
