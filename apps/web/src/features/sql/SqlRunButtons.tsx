"use client";

import AccountTreeOutlined from "@mui/icons-material/AccountTreeOutlined";
import InsightsOutlined from "@mui/icons-material/InsightsOutlined";
import PlayArrowRounded from "@mui/icons-material/PlayArrowRounded";
import StopCircleOutlined from "@mui/icons-material/StopCircleOutlined";
import Button from "@mui/material/Button";
import type { QueryParams } from "@workhouse/protocol";

import { useAnalyze } from "@/features/analyze/useAnalyze";

import type { useSqlRunner } from "./useSqlRunner";

/**
 * Explain, analyze (profile), interrupt and run a query on the default cluster.
 * `source` names where the query comes from in the analysis (a SQL file's path);
 * `values` are its parameters, `blocked` (a parameter has no value) stops running.
 */
export function SqlRunButtons({
  runner,
  onRun,
  query,
  source = "sql editor",
  values,
  blocked = false,
}: {
  runner: ReturnType<typeof useSqlRunner>;
  onRun(): void;
  query: string;
  source?: string;
  values?: QueryParams;
  blocked?: boolean;
}) {
  const { analyze, pending } = useAnalyze();
  return (
    <>
      <Button startIcon={<AccountTreeOutlined />} disabled={blocked} onClick={() => runner.explain(query, values)} sx={{ color: "text.secondary" }}>
        Explain
      </Button>
      <Button
        startIcon={<InsightsOutlined />}
        aria-label="analyze query"
        onClick={() => analyze(query, source, values)}
        disabled={runner.running || pending || !query.trim() || blocked}
        sx={{ color: "text.secondary" }}
      >
        Analyze
      </Button>
      <Button startIcon={<StopCircleOutlined />} color="error" disabled={!runner.running} onClick={runner.interrupt}>
        Interrupt
      </Button>
      <Button variant="contained" color="secondary" startIcon={<PlayArrowRounded />} onClick={onRun} disabled={runner.running || blocked}>
        Run
      </Button>
    </>
  );
}
