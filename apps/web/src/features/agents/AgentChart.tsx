"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

import { ChartCanvas } from "@/features/results/chart/ChartCanvas";
import type { IaraChart } from "@/lib/iara/protocol";

/** A chart an agent drew under its answer. */
export function AgentChart({ chart, height = 260 }: { chart: IaraChart; height?: number }) {
  return (
    <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, px: 1.5, pt: 1, pb: 0.5, bgcolor: "background.paper" }}>
      <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 0.5 }}>{chart.title}</Typography>
      {/* the title names what is drawn: an axis name would repeat a column name */}
      <ChartCanvas data={chart.data} spec={chart.spec} height={height} xType={chart.xType} style={{ x_title: "" }} />
    </Box>
  );
}
