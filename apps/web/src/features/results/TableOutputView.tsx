"use client";

import Download from "@mui/icons-material/Download";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";
import type { ChartSpec, TableOutput, TablesOutput } from "@iara/protocol";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useGuard, useNotify } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { formatCount, formatDuration } from "@/lib/format";
import { exportResult } from "@/server/actions/kernels";

import { ChartView } from "./chart/ChartView";
import { PlanTree } from "./PlanTree";
import { ProfileView } from "./ProfileView";
import { ResultTable } from "./ResultTable";
import { WranglerView } from "@/features/wrangler";

function ExportButton({ kernelKey, output, format }: { kernelKey: string; output: TableOutput; format: "csv" | "parquet" }) {
  const { t } = useTranslation();
  const guard = useGuard();
  const notify = useNotify();
  const run = () =>
    guard(async () => {
      const { path } = unwrap(await exportResult(kernelKey, output.result.id, format));
      notify(t("Download started"), "success");
      window.location.href = `/api/download?kernel=${encodeURIComponent(kernelKey)}&path=${encodeURIComponent(path)}`;
    });
  return (
    <Button size="small" startIcon={<Download fontSize="small" />} onClick={run} sx={{ color: "text.secondary" }} title={`Download all the rows as ${format.toUpperCase()}`}>
      {format.toUpperCase()}
    </Button>
  );
}

/** "1,204 rows", or "first 500 of 1,204 rows" for a preview. */
export function rowsLabel(result: { num_rows: number; truncated?: boolean; total_rows?: number | null }): string {
  if (!result.truncated) return `${formatCount(result.num_rows)} rows`;
  return result.total_rows != null ? `first ${formatCount(result.num_rows)} of ${formatCount(result.total_rows)} rows` : `first ${formatCount(result.num_rows)} rows`;
}

export interface ChartProps {
  /** the chart saved with the output's cell or query (shown first when there is one) */
  chart?: ChartSpec | null;
  /** save a changed chart (without it, changes last as long as the output) */
  onChart?(spec: ChartSpec): void;
}

/** A table result with a chart of it, and its run profile and plan when it has them. */
export function TableOutputView({ kernelKey, output, height, chart, onChart }: { kernelKey: string; output: TableOutput; height?: number } & ChartProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"result" | "chart" | "wrangle" | "profile" | "plan">(chart ? "chart" : "result");
  const [local, setLocal] = useState<ChartSpec | null>(null);
  const { result, profile, plan } = output;
  const spec = onChart ? (chart ?? null) : local;
  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1, borderBottom: 1, borderColor: "divider" }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ minHeight: 34, "& .MuiTab-root": { minHeight: 34, py: 0, px: 1.5, fontSize: 12.5 } }}>
          <Tab value="result" label={t("Result")} />
          <Tab value="chart" label={t("Chart")} />
          <Tab value="wrangle" label={t("Wrangle")} />
          {profile && <Tab value="profile" label={t("Profile")} />}
          {plan && <Tab value="plan" label={t("Plan")} />}
        </Tabs>

        <Typography variant="body2" sx={{ color: "text.secondary", px: 1 }}>
          {rowsLabel(result)} × {result.columns.length} columns
          {profile && ` · ${formatDuration(profile.elapsed_ms)}`}
          {result.on_disk && " · on disk"}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <ExportButton kernelKey={kernelKey} output={output} format="csv" />
        <ExportButton kernelKey={kernelKey} output={output} format="parquet" />
      </Box>
      {tab === "result" && <ResultTable kernelKey={kernelKey} meta={result} height={height} />}
      {tab === "chart" && <ChartView kernelKey={kernelKey} meta={result} spec={spec} onSpec={onChart ?? setLocal} />}
      {tab === "wrangle" && (
        <Box sx={{ height: Math.max(460, height ?? 460) }}>
          <WranglerView kernelKey={kernelKey} source={{ result_id: result.id }} label="this result" height="100%" />
        </Box>
      )}
      {tab === "profile" && profile && <ProfileView profile={profile} />}
      {tab === "plan" && plan && <PlanTree plan={plan} />}
    </Box>
  );
}

/** The tables of a cell that previewed several frames: one tab each, named after its variable. */
export function TablesOutputView({ kernelKey, output, height }: { kernelKey: string; output: TablesOutput; height?: number }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState(0);
  const at = Math.min(tab, output.tables.length - 1);
  return (
    <Box>
      <Tabs
        value={at}
        onChange={(_, v) => setTab(v)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ minHeight: 34, px: 1, borderBottom: 1, borderColor: "divider", "& .MuiTab-root": { minHeight: 34, py: 0, px: 1.5, fontSize: 12.5, textTransform: "none" } }}
      >
        {output.tables.map((o, i) => (
          <Tab key={i} value={i} label={o.name ?? t("Preview {{n}}", { n: i + 1 })} sx={o.name ? { fontFamily: "'JetBrains Mono Variable', monospace" } : undefined} />
        ))}
      </Tabs>
      {/* keyed: each table opens on its rows */}
      <TableOutputView key={at} kernelKey={kernelKey} output={output.tables[at]} height={height} />
    </Box>
  );
}
