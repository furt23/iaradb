"use client";

import Box from "@mui/material/Box";
import type { AnalyzedNode } from "@iara/protocol";
import { useLayoutEffect, useMemo, useRef } from "react";

import { GraphLinks } from "./GraphLinks";
import { BOX, layoutTree } from "./layout";
import { hottestMs } from "./metrics";
import { PlanNodeBox } from "./PlanNodeBox";
import { usePan } from "./usePan";

/** the space around the boxes, so none sits on the edge of the area */
export const MARGIN = 24;

interface Props {
  plan: AnalyzedNode;
  totalMs: number;
  onOpen(node: AnalyzedNode): void;
}

/**
 * The whole plan as boxes linked the way the rows flow, the scans on top, filling
 * its parent. It opens on the root's column; drag the background, or scroll, to pan.
 */
export function PlanGraph({ plan, totalMs, onOpen }: Props) {
  const layout = useMemo(() => layoutTree(plan), [plan]);
  const hottest = useMemo(() => hottestMs(plan), [plan]);
  const pan = usePan<HTMLDivElement>();
  const area = useRef<HTMLDivElement>(null);
  const width = layout.width + 2 * MARGIN;
  const height = layout.height + 2 * MARGIN;
  const rootLeft = layout.boxes.find((b) => b.id === "0")?.left ?? 0;

  useLayoutEffect(() => {
    const el = area.current;
    if (el) el.scrollTo({ left: rootLeft + MARGIN + BOX.width / 2 - el.clientWidth / 2, top: 0 });
  }, [rootLeft, layout]);

  return (
    <Box ref={area} {...pan} sx={{ height: "100%", overflow: "auto", cursor: "grab", userSelect: "none", "&:active": { cursor: "grabbing" } }}>
      <Box sx={{ position: "relative", width, height, mx: "auto" }}>
        <GraphLinks links={layout.links} width={width} height={height} margin={MARGIN} />
        {layout.boxes.map((placed) => (
          <PlanNodeBox key={placed.id} placed={placed} margin={MARGIN} totalMs={totalMs} hottestMs={hottest} onOpen={onOpen} />
        ))}
      </Box>
    </Box>
  );
}
