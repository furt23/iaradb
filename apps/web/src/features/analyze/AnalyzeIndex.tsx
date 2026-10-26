"use client";

import InsightsOutlined from "@mui/icons-material/InsightsOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { CodeEditor } from "@/features/editor/CodeEditor";
import { PageHeader } from "@/features/shell/PageHeader";

import { AnalysesTable } from "./AnalysesTable";
import type { AnalysisSummary } from "./types";
import { useAnalyze } from "./useAnalyze";

/** Paste a query, analyze it on the workspace kernel, or open a recent analysis. */
export function AnalyzeIndex({ analyses, schema }: { analyses: AnalysisSummary[]; schema: Record<string, { name: string }[]> }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const { analyze, pending } = useAnalyze();
  const run = () => {
    if (query.trim() && !pending) void analyze(query);
  };
  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <PageHeader
        title={t("Analyze")}
        actions={
          <Button variant="contained" color="secondary" startIcon={<InsightsOutlined />} onClick={run} disabled={pending || !query.trim()}>
            {t("Analyze")}
          </Button>
        }
      />
      {pending && <LinearProgress sx={{ height: 2, flexShrink: 0 }} />}
      <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2, flex: 1, minHeight: 0, overflow: "auto" }}>
        <Paper variant="outlined" sx={{ overflow: "hidden", flexShrink: 0 }}>
          <CodeEditor value={query} onChange={setQuery} language="sql" schema={schema} onRun={run} onRunInPlace={run} minHeight={120} maxHeight={260} autoFocus />
        </Paper>
        <Typography variant="h3" sx={{ flexShrink: 0 }}>
          {t("Recent analyses")}
        </Typography>
        <Box sx={{ height: 520, flexShrink: 0 }}>
          <AnalysesTable analyses={analyses} />
        </Box>
      </Box>
    </Box>
  );
}

