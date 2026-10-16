"use client";

import Box from "@mui/material/Box";
import LinearProgress from "@mui/material/LinearProgress";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { PipelineStats, QueryProfile } from "@iara/protocol";

import { formatBytes, formatCompact, formatCount, formatDuration } from "@/lib/format";

import { operatorColor, operatorName } from "./operators";

function Step({ label }: { label: string }) {
  const color = operatorColor(label);
  return (
    <Tooltip title={<Box sx={{ fontFamily: "monospace", fontSize: 11 }}>{label}</Box>}>
      <Box
        component="span"
        sx={{ px: 0.75, py: 0.1, borderRadius: 1, fontSize: 11, fontWeight: 650, whiteSpace: "nowrap", border: 1, borderColor: color, color }}
      >
        {operatorName(label)}
      </Box>
    </Tooltip>
  );
}

function PipelineRow({ p, total, index }: { p: PipelineStats; total: number; index: number }) {
  const share = total > 0 ? (p.elapsed_ms / total) * 100 : 0;
  const steps = [p.source, ...p.operators];
  return (
    <Box sx={{ display: "grid", gridTemplateColumns: "28px 1fr 260px", gap: 1.5, alignItems: "center", py: 1, borderBottom: 1, borderColor: "divider" }}>
      <Typography variant="mono" sx={{ color: "text.disabled", textAlign: "right" }}>
        {index + 1}
      </Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, alignItems: "center", minWidth: 0 }}>
        {steps.map((s, i) => (
          <Box key={i} sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            {i > 0 && <Box sx={{ color: "text.disabled", fontSize: 11 }}>→</Box>}
            <Step label={s} />
          </Box>
        ))}
        <Box sx={{ color: "text.disabled", fontSize: 11 }}>⇒</Box>
        <Typography variant="mono" sx={{ fontSize: 11, color: "text.secondary" }}>
          {p.sink.replace("Sink", "")}
        </Typography>
      </Box>
      <Box>
        <Box sx={{ display: "flex", justifyContent: "space-between", mb: 0.5 }}>
          <Typography variant="mono" sx={{ fontWeight: 700 }}>
            {formatDuration(p.elapsed_ms)}
          </Typography>
          <Typography variant="mono" sx={{ color: "text.secondary" }} title={`${formatCount(p.rows_in)} rows in → ${formatCount(p.rows_out)} rows out`}>
            {formatCompact(p.rows_in)} → {formatCompact(p.rows_out)} rows
          </Typography>
        </Box>
        <LinearProgress
          variant="determinate"
          value={p.finished ? share : (p.morsels_done / Math.max(1, p.morsels_total)) * 100}
          color={p.finished ? "primary" : "ochre"}
          sx={{ height: 6, borderRadius: 3 }}
        />
      </Box>
    </Box>
  );
}

/** Per-pipeline timings of a query run (or live progress while it runs). */
export function ProfileView({ profile }: { profile: QueryProfile }) {
  const total = profile.pipelines.reduce((a, p) => a + p.elapsed_ms, 0);
  return (
    <Box sx={{ px: 2, py: 1 }}>
      <Typography variant="body2" sx={{ color: "text.secondary", mb: 1 }}>
        {profile.pipelines.length} pipelines · {formatDuration(profile.elapsed_ms)} total
        {profile.memory_peak ? ` · ${formatBytes(profile.memory_peak)} memory peak` : ""}
        {profile.spilled_bytes ? ` · ${formatBytes(profile.spilled_bytes)} spilled to disk` : ""}
        {profile.cancelled && " · cancelled"}
      </Typography>
      {profile.pipelines.map((p, i) => (
        <PipelineRow key={i} p={p} total={total} index={i} />
      ))}
    </Box>
  );
}

/** Compact live progress of running queries. */
export function LiveProgress({ queries }: { queries: QueryProfile[] }) {
  const q = queries[queries.length - 1];
  if (!q) return null;
  const current = q.pipelines.find((p) => !p.finished) ?? q.pipelines[q.pipelines.length - 1];
  if (!current) return <LinearProgress sx={{ height: 3 }} />;
  const pct = (current.morsels_done / Math.max(1, current.morsels_total)) * 100;
  return (
    <Box sx={{ px: 1.5, py: 0.75 }}>
      <Box sx={{ display: "flex", gap: 1, alignItems: "center", mb: 0.5 }}>
        <Step label={current.source} />
        <Typography variant="mono" sx={{ color: "text.secondary" }}>
          pipeline {q.pipelines.indexOf(current) + 1} · {current.morsels_done}/{current.morsels_total} morsels · {formatCompact(current.rows_in)} rows ·{" "}
          {formatDuration(q.elapsed_ms)}
        </Typography>
      </Box>
      <LinearProgress variant="determinate" value={pct} sx={{ height: 3, borderRadius: 2 }} />
    </Box>
  );
}
