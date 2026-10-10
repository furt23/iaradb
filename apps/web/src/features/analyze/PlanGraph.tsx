"use client";

import Box from "@mui/material/Box";
import type { AnalyzedNode } from "@workhouse/protocol";
import { useMemo } from "react";

import { layoutTree } from "./layout";
import { hottestMs } from "./metrics";
import { PlanNodeBox } from "./PlanNodeBox";
import { usePan } from "./usePan";

/** the space around the boxes, so none sits on the edge of the area */
const MARGIN = 24;

interface Props {
  plan: AnalyzedNode;
  totalMs: number;
  onOpen(node: AnalyzedNode): void;
}

/** The plan as a top-down tree of operator boxes. Drag the background, or scroll, to pan. */
export function PlanGraph({ plan, totalMs, onOpen }: Props) {
  const layout = useMemo(() => layoutTree(plan), [plan]);
  const hottest = useMemo(() => hottestMs(plan), [plan]);
  const pan = usePan<HTMLDivElement>();
  const width = layout.width + 2 * MARGIN;
  const height = layout.height + 2 * MARGIN;
  return (
    <Box {...pan} sx={{ height: 560, maxHeight: "70vh", overflow: "auto", cursor: "grab", userSelect: "none", "&:active": { cursor: "grabbing" } }}>
      <Box sx={{ position: "relative", width, height }}>
        <Box
          component="svg"
          width={width}
          height={height}
          aria-hidden
          sx={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", "& path": { fill: "none", stroke: "divider", strokeWidth: 1.5 } }}
        >
          <g transform={`translate(${MARGIN} ${MARGIN})`}>
            {layout.links.map((l) => {
              const mid = (l.y1 + l.y2) / 2;
              return <path key={`${l.from}>${l.to}`} d={`M${l.x1} ${l.y1} C${l.x1} ${mid} ${l.x2} ${mid} ${l.x2} ${l.y2}`} />;
            })}
          </g>
        </Box>
        {layout.boxes.map((placed) => (
          <PlanNodeBox key={placed.id} placed={placed} margin={MARGIN} totalMs={totalMs} hottestMs={hottest} onOpen={onOpen} />
        ))}
      </Box>
    </Box>
  );
}
