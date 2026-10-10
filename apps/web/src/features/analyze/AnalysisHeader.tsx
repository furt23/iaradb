"use client";

import CodeRounded from "@mui/icons-material/CodeRounded";
import ReplayRounded from "@mui/icons-material/ReplayRounded";
import Button from "@mui/material/Button";
import { useRouter } from "next/navigation";

import { LocalTime } from "@/features/shell/LocalTime";
import { PageHeader } from "@/features/shell/PageHeader";

import type { StoredAnalysis } from "./types";
import { useAnalyze } from "./useAnalyze";

/** The analysis's title, when it ran, and the actions: run it again, or open its query in the SQL editor. */
export function AnalysisHeader({ analysis }: { analysis: StoredAnalysis }) {
  const router = useRouter();
  const { analyze, pending } = useAnalyze();
  return (
    <PageHeader
      title="Analysis"
      subtitle={
        <>
          Ran <LocalTime ms={analysis.at} />
          {analysis.source ? ` from ${analysis.source}` : ""}
        </>
      }
      actions={
        <>
          <Button startIcon={<CodeRounded />} onClick={() => router.push(`/sql?q=${encodeURIComponent(analysis.query)}`)} sx={{ color: "text.secondary" }}>
            Open in SQL editor
          </Button>
          <Button variant="outlined" startIcon={<ReplayRounded />} onClick={() => analyze(analysis.query, analysis.source)} disabled={pending}>
            Run again
          </Button>
        </>
      }
    />
  );
}
