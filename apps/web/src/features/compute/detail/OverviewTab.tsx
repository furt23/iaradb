"use client";

import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import { Fragment, type ReactNode } from "react";

import { costSoFar, formatMinutes, formatUsd, minutesSince, terminatesIn } from "@/lib/clusterTime";
import { formatRelative } from "@/lib/format";
import type { ClusterView } from "@/server/compute/types";

type Row = [label: string, value: ReactNode];

/** Label and value pairs in two columns (one on a phone). */
function Facts({ rows }: { rows: Row[] }) {
  return (
    <Box component="dl" sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "max-content 1fr" }, columnGap: 4, rowGap: 1.25, m: 0 }}>
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <Typography component="dt" sx={{ color: "text.secondary", fontSize: 14 }}>
            {label}
          </Typography>
          <Typography component="dd" sx={{ m: 0, fontSize: 14, overflowWrap: "anywhere" }}>
            {value}
          </Typography>
        </Fragment>
      ))}
    </Box>
  );
}

function machineRows(c: ClusterView, createdAt: number | null, now: number): Row[] {
  const t = c.instanceType;
  const running = c.state === "running";
  const left = terminatesIn(c, now);
  const idle = minutesSince(c.lastActivity, now);
  const cost = costSoFar(c, now);
  return [
    ["Machine", t?.name ?? "unknown"],
    ["vCPU", t ? String(t.vcpus) : "—"],
    ["Memory", t ? `${t.memoryGib} GiB` : "—"],
    ["Price", t ? `≈ $${t.usdPerHour.toFixed(2)}/h` : "—"],
    ["Disk", c.volumeGb ? `${c.volumeGb} GB` : "—"],
    ["Auto-terminate", `${c.autoTerminateMinutes} min idle${left !== null ? ` · terminates in ${left} min if idle` : ""}`],
    ["Uptime", running ? formatMinutes(minutesSince(c.startedAt, now) ?? 0) : "—"],
    ["Idle", running && idle !== null ? formatMinutes(idle) : "—"],
    ["Cost so far", cost !== null ? formatUsd(cost) : "—"],
    ["Public IP", c.publicIp ?? "—"],
    ["Notebooks attached", String(c.notebooks.length)],
    ["Default", c.isDefault ? "yes" : "no"],
    ["Created", createdAt ? `${new Date(createdAt).toLocaleString()} (${formatRelative(createdAt, now)})` : "—"],
    ...(c.error ? [["Error", <Box component="span" key="error" sx={{ color: "error.main" }}>{c.error}</Box>] as Row] : []),
  ];
}

function localRows(c: ClusterView, kernels: number): Row[] {
  return [
    ["Machine", "this machine (development only)"],
    ["Notebooks attached", String(c.notebooks.length)],
    ["Kernels running", String(kernels)],
    ["Default", c.isDefault ? "yes" : "no"],
  ];
}

/** The machine of a cluster: its size, price, limits and times. */
export function OverviewTab({ cluster: c, createdAt, now, kernels }: { cluster: ClusterView; createdAt: number | null; now: number; kernels: number }) {
  const rows = c.kind === "local" ? localRows(c, kernels) : machineRows(c, createdAt, now);
  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Facts rows={rows} />
    </Paper>
  );
}
