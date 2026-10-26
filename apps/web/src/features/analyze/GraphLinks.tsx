"use client";

import { useTheme } from "@mui/material/styles";
import { useId } from "react";

import type { Link } from "./layout";

interface Props {
  links: Link[];
  width: number;
  height: number;
  /** the space around the boxes */
  margin: number;
}

/** The arrows between a graph's boxes, under them: each from a box's bottom to the next one's top. */
export function GraphLinks({ links, width, height, margin }: Props) {
  const theme = useTheme();
  // two graphs on a page must not share the marker's id (useId's own characters are not valid in url())
  const arrow = `arrow${useId().replace(/[^\w-]/g, "")}`;
  const color = theme.palette.text.disabled;
  return (
    <svg width={width} height={height} aria-hidden style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }}>
      <defs>
        <marker id={arrow} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0 L8 4 L0 8 z" fill={color} />
        </marker>
      </defs>
      <g transform={`translate(${margin} ${margin})`}>
        {links.map((l) => {
          const mid = (l.y1 + l.y2) / 2;
          return (
            <path
              key={`${l.from}>${l.to}`}
              d={`M${l.x1} ${l.y1} C${l.x1} ${mid} ${l.x2} ${mid} ${l.x2} ${l.y2}`}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              markerEnd={`url(#${arrow})`}
            />
          );
        })}
      </g>
    </svg>
  );
}
