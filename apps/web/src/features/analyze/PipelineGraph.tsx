"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Typography from "@mui/material/Typography";
import type { AnalyzedNode, PipelineStats } from "@iara/protocol";
import { Fragment } from "react";

import { operatorName } from "@/features/results/operators";

import { GraphLinks } from "./GraphLinks";
import { BOX, type Link } from "./layout";
import { PlanNodeBox } from "./PlanNodeBox";
import { MARGIN } from "./PlanGraph";
import { pipelineAfter, pipelinesInto, sinkName, sourceLabel } from "./pipelines";

/** the column left of the boxes, for the pipelines that feed them */
const INPUTS = 170;
const CHIP_HEIGHT = 24;

interface Props {
  pipelines: PipelineStats[];
  index: number;
  /** the plan's nodes in pre-order (a pipeline's `nodes` index them) */
  nodes: AnalyzedNode[];
  totalMs: number;
  onOpen(node: AnalyzedNode): void;
  /** show another pipeline */
  onPick(index: number): void;
}

/**
 * One pipeline as the chain of operators it runs, its source on top and its sink
 * at the bottom. Beside an operator, the pipelines it reads (a join's build side,
 * an earlier result); under the sink, the pipeline that goes on from it.
 */
export function PipelineGraph({ pipelines, index, nodes, totalMs, onOpen, onPick }: Props) {
  const p = pipelines[index];
  const ids = (p.nodes ?? []).filter((id) => id < nodes.length);
  if (ids.length === 0) {
    // runs from before pipelines named their nodes
    return (
      <Typography variant="mono" sx={{ display: "block", p: 2, fontSize: 12, color: "text.secondary" }}>
        {[p.source, ...p.operators].map(operatorName).join(" → ")} ⇒ {sinkName(p.sink)}
      </Typography>
    );
  }
  const row = BOX.height + BOX.gapY;
  const x = INPUTS + BOX.width / 2;
  const links: Link[] = ids.slice(1).map((id, k) => ({ from: String(ids[k]), to: String(id), x1: x, y1: k * row + BOX.height, x2: x, y2: (k + 1) * row }));
  const next = pipelineAfter(pipelines, index);
  const width = INPUTS + BOX.width + 2 * MARGIN;
  const height = ids.length * row - BOX.gapY + (next == null ? 0 : CHIP_HEIGHT + 16) + 2 * MARGIN;
  const hottest = Math.max(0, ...ids.map((id) => nodes[id].metrics?.elapsed_ms ?? 0));
  const chip = (j: number, label: string, left: number, top: number) => (
    <Chip
      key={`${j}@${top}`}
      size="small"
      variant="outlined"
      label={label}
      onClick={() => onPick(j)}
      sx={{ position: "absolute", left: left + MARGIN, top: top + MARGIN, maxWidth: INPUTS - 12, height: CHIP_HEIGHT, fontSize: 11 }}
    />
  );

  return (
    <Box sx={{ height: "100%", overflow: "auto" }}>
      <Box sx={{ position: "relative", width, height, mx: "auto" }}>
        <GraphLinks links={links} width={width} height={height} margin={MARGIN} />
        {ids.map((id, k) => (
          <Fragment key={id}>
            <PlanNodeBox placed={{ id: String(id), node: nodes[id], depth: k, left: INPUTS, top: k * row }} margin={MARGIN} totalMs={totalMs} hottestMs={hottest} onOpen={onOpen} />
            {pipelinesInto(pipelines, index, id).map((j, m) =>
              chip(j, `#${j + 1} ${sourceLabel(pipelines[j], nodes)} →`, 0, k * row + (BOX.height - CHIP_HEIGHT) / 2 + m * (CHIP_HEIGHT + 4)),
            )}
          </Fragment>
        ))}
        {next != null && chip(next, `→ #${next + 1} ${sinkName(pipelines[next].sink)}`, INPUTS + BOX.width / 2 - 60, ids.length * row - BOX.gapY + 16)}
      </Box>
    </Box>
  );
}
