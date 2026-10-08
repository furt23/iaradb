"use client";

import Download from "@mui/icons-material/Download";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";
import type { TableOutput } from "@workhouse/protocol";
import { useState } from "react";

import { useGuard, useNotify } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { formatCount, formatDuration } from "@/lib/format";
import { exportResult } from "@/server/actions/kernels";

import { PlanTree } from "./PlanTree";
import { ProfileView } from "./ProfileView";
import { ResultTable } from "./ResultTable";

function ExportButton({ kernelKey, output, format }: { kernelKey: string; output: TableOutput; format: "csv" | "parquet" }) {
  const guard = useGuard();
  const notify = useNotify();
  const run = () =>
    guard(async () => {
      const { path } = unwrap(await exportResult(kernelKey, output.result.id, format));
      notify(`Exported to ${path}`, "success");
      window.location.href = `/api/download?kernel=${encodeURIComponent(kernelKey)}&path=${encodeURIComponent(path)}`;
    });
  return (
    <Button size="small" startIcon={<Download fontSize="small" />} onClick={run} sx={{ color: "text.secondary" }}>
      {format.toUpperCase()}
    </Button>
  );
}

/** A table result with its run profile and plan, when it has them. */
export function TableOutputView({ kernelKey, output, height }: { kernelKey: string; output: TableOutput; height?: number }) {
  const [tab, setTab] = useState<"result" | "profile" | "plan">("result");
  const { result, profile, plan } = output;
  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1, borderBottom: 1, borderColor: "divider" }}>
        {(profile || plan) && (
          <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ minHeight: 34, "& .MuiTab-root": { minHeight: 34, py: 0, px: 1.5, fontSize: 12.5 } }}>
            <Tab value="result" label="Result" />
            {profile && <Tab value="profile" label="Profile" />}
            {plan && <Tab value="plan" label="Plan" />}
          </Tabs>
        )}
        <Typography variant="body2" sx={{ color: "text.secondary", px: 1 }}>
          {formatCount(result.num_rows)} rows × {result.columns.length} columns
          {profile && ` · ${formatDuration(profile.elapsed_ms)}`}
          {result.on_disk && (
            <Box component="span" title="Larger than the kernel's result memory: kept on disk and read page by page">
              {" · on disk"}
            </Box>
          )}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <ExportButton kernelKey={kernelKey} output={output} format="csv" />
        <ExportButton kernelKey={kernelKey} output={output} format="parquet" />
      </Box>
      {tab === "result" && <ResultTable kernelKey={kernelKey} meta={result} height={height} />}
      {tab === "profile" && profile && <ProfileView profile={profile} />}
      {tab === "plan" && plan && <PlanTree plan={plan} />}
    </Box>
  );
}
