"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { Variable } from "@workhouse/protocol";

export function VariablesPanel({ variables }: { variables: Variable[] }) {
  return (
    <Box component="aside" sx={{ width: 300, flexShrink: 0, borderLeft: 1, borderColor: "divider", bgcolor: "background.paper", overflow: "auto" }}>
      <Typography variant="overline" sx={{ display: "block", px: 2, pt: 1.5, color: "text.disabled" }}>
        Variables
      </Typography>
      {variables.length === 0 && (
        <Typography variant="body2" sx={{ px: 2, color: "text.secondary" }}>
          Run cells to see the values they define.
        </Typography>
      )}
      {variables.map((v) => (
        <Box key={v.name} sx={{ px: 2, py: 0.75, borderBottom: 1, borderColor: "divider" }}>
          <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1 }}>
            <Typography variant="mono" sx={{ color: "secondary.main", fontWeight: 700 }}>
              {v.name}
            </Typography>
            <Typography variant="mono" sx={{ color: "text.disabled", fontSize: 11 }}>
              {v.type}
            </Typography>
          </Box>
          <Typography variant="mono" sx={{ color: "text.secondary", fontSize: 11, wordBreak: "break-all" }}>
            {v.summary}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}
