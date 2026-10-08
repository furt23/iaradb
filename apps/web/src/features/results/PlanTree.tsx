"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { PlanNode } from "@workhouse/protocol";

import { operatorColor } from "./operators";

function Node({ node, depth }: { node: PlanNode; depth: number }) {
  const color = operatorColor(node.name);
  return (
    <Box sx={{ position: "relative", pl: depth ? 2.5 : 0 }}>
      {depth > 0 && <Box sx={{ position: "absolute", left: 8, top: 0, bottom: 0, borderLeft: 1, borderColor: "divider" }} />}
      <Box sx={{ display: "flex", gap: 1, alignItems: "baseline", py: 0.5 }}>
        {node.role && (
          <Typography variant="mono" sx={{ fontSize: 10.5, color: "text.disabled", textTransform: "uppercase", minWidth: 40 }}>
            {node.role}
          </Typography>
        )}
        <Box sx={{ px: 0.75, borderRadius: 1, fontSize: 11.5, fontWeight: 700, color: "background.default", bgcolor: color, whiteSpace: "nowrap" }}>
          {node.name}
        </Box>
        <Typography variant="mono" sx={{ fontSize: 11.5, color: "text.secondary", wordBreak: "break-word" }}>
          {node.detail === node.name ? "" : node.detail}
        </Typography>
      </Box>
      {node.children.map((c, i) => (
        <Node key={i} node={c} depth={depth + 1} />
      ))}
    </Box>
  );
}

/** The physical plan as a tree (joins show their probe and build sides). */
export function PlanTree({ plan }: { plan: PlanNode }) {
  return (
    <Box sx={{ px: 2, py: 1.5, overflow: "auto" }}>
      <Node node={plan} depth={0} />
    </Box>
  );
}
