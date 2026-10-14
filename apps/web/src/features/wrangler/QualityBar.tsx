"use client";

import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import type { ColumnQuality } from "@workhouse/protocol";

/** Share of valid (green), null (grey) and empty-string (amber) values of a column, over all rows. */
export function QualityBar({ quality }: { quality: ColumnQuality }) {
  const { total, nulls, empty } = quality;
  if (total === 0) return null;
  const valid = total - nulls - empty;
  const pct = (n: number) => (n / total) * 100;
  const tip = `${valid} valid, ${nulls} null${empty > 0 ? `, ${empty} empty` : ""} of ${total}`;
  return (
    <Tooltip title={tip} arrow placement="top">
      <Box sx={{ display: "flex", height: 3, width: "100%", borderRadius: 1, overflow: "hidden", my: 0.5, bgcolor: "divider" }}>
        {valid > 0 && <Box sx={{ width: `${pct(valid)}%`, bgcolor: "success.main" }} />}
        {nulls > 0 && <Box sx={{ width: `${pct(nulls)}%`, bgcolor: "text.disabled" }} />}
        {empty > 0 && <Box sx={{ width: `${pct(empty)}%`, bgcolor: "warning.main" }} />}
      </Box>
    </Tooltip>
  );
}
