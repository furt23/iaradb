"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

import { OutputView } from "@/features/results/OutputView";
import { PlanTree } from "@/features/results/PlanTree";
import { LiveProgress } from "@/features/results/ProfileView";
import type { ChartProps } from "@/features/results/TableOutputView";

import type { useSqlRunner } from "./useSqlRunner";

/** A query's live progress, then its result (and chart), plan or error. */
export function SqlResult({ runner, tableHeight = 480, chart, onChart }: { runner: ReturnType<typeof useSqlRunner>; tableHeight?: number } & ChartProps) {
  const { view, running, progress } = runner;
  return (
    <>
      {running && <LiveProgress queries={progress} />}
      {!view ? (
        <Typography sx={{ color: "text.secondary", p: 3 }}>
          Run a query with <b>Ctrl+Enter</b>.
        </Typography>
      ) : view.kind === "error" ? (
        <Typography variant="mono" component="pre" sx={{ p: 2, m: 0, color: "error.main", whiteSpace: "pre-wrap" }}>
          {view.message}
        </Typography>
      ) : view.kind === "explain" ? (
        <Box>
          <PlanTree plan={view.plan} />
          <Typography variant="mono" component="pre" sx={{ px: 2, pb: 2, m: 0, color: "text.secondary", whiteSpace: "pre-wrap", fontSize: 11.5 }}>
            {view.text}
          </Typography>
        </Box>
      ) : (
        <OutputView output={view.output} kernelKey="workspace" tableHeight={tableHeight} chart={chart} onChart={onChart} />
      )}
    </>
  );
}
