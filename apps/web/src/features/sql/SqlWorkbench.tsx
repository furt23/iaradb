"use client";

import AccountTreeOutlined from "@mui/icons-material/AccountTreeOutlined";
import PlayArrowRounded from "@mui/icons-material/PlayArrowRounded";
import StopCircleOutlined from "@mui/icons-material/StopCircleOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import { useState } from "react";

import { CodeEditor } from "@/features/editor/CodeEditor";
import { OutputView } from "@/features/results/OutputView";
import { PlanTree } from "@/features/results/PlanTree";
import { LiveProgress } from "@/features/results/ProfileView";
import { PageHeader } from "@/features/shell/PageHeader";

import { useSqlRunner, type SqlView } from "./useSqlRunner";

function ResultArea({ view }: { view: SqlView }) {
  if (!view) {
    return (
      <Typography sx={{ color: "text.secondary", p: 3 }}>
        Run a query with <b>Ctrl+Enter</b>. Every catalog table is available by name.
      </Typography>
    );
  }
  if (view.kind === "error") {
    return (
      <Typography variant="mono" component="pre" sx={{ p: 2, m: 0, color: "error.main", whiteSpace: "pre-wrap" }}>
        {view.message}
      </Typography>
    );
  }
  if (view.kind === "explain") {
    return (
      <Box>
        <PlanTree plan={view.plan} />
        <Typography variant="mono" component="pre" sx={{ px: 2, pb: 2, m: 0, color: "text.secondary", whiteSpace: "pre-wrap", fontSize: 11.5 }}>
          {view.text}
        </Typography>
      </Box>
    );
  }
  return <OutputView output={view.output} kernelKey="workspace" tableHeight={480} />;
}

export function SqlWorkbench({ initialQuery, schema }: { initialQuery: string; schema: Record<string, { name: string }[]> }) {
  const [query, setQuery] = useState(initialQuery);
  const sql = useSqlRunner();
  const run = () => !sql.running && query.trim() && sql.run(query);
  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <PageHeader
        title="SQL editor"
        subtitle="Scratch queries over the workspace catalog"
        actions={
          <>
            <Button startIcon={<AccountTreeOutlined />} onClick={() => sql.explain(query)} sx={{ color: "text.secondary" }}>
              Explain
            </Button>
            <Button startIcon={<StopCircleOutlined />} color="error" disabled={!sql.running} onClick={sql.interrupt}>
              Interrupt
            </Button>
            <Button variant="contained" color="secondary" startIcon={<PlayArrowRounded />} onClick={run} disabled={sql.running}>
              Run
            </Button>
          </>
        }
      />
      <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2, flex: 1, minHeight: 0, overflow: "auto" }}>
        <Paper variant="outlined" sx={{ overflow: "hidden", flexShrink: 0 }}>
          <CodeEditor value={query} onChange={setQuery} language="sql" schema={schema} onRun={run} onRunInPlace={run} minHeight={160} maxHeight={360} autoFocus />
        </Paper>
        <Paper variant="outlined" sx={{ overflow: "hidden", flexShrink: 0 }}>
          {sql.running && <LiveProgress queries={sql.progress} />}
          <ResultArea view={sql.view} />
        </Paper>
      </Box>
    </Box>
  );
}
