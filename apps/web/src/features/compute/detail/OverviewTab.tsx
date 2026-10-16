"use client";

import Chip from "@mui/material/Chip";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import type { TFunction } from "i18next";
import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { formatMinutes, minutesSince, terminatesIn } from "@/lib/clusterTime";
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

/** Spot or on-demand, and what the machine actually got at its start. */
function marketLabel(c: ClusterView, t: TFunction): string {
  if (c.spot && c.state === "running" && c.runningSpot === false) return t("On-demand (no spot capacity at start)");
  return c.spot ? t("Spot") : t("On-demand");
}

/** The hard limit, and when the machine ends if it is running. */
function timeLimit(c: ClusterView, t: TFunction): string {
  if (c.maxHours === undefined) return "—";
  const hours = t("{{n}} h", { n: c.maxHours });
  if (c.state !== "running" || !c.startedAt) return hours;
  const end = new Date(c.startedAt + c.maxHours * 3600_000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return t("{{hours}} · ends at {{time}}", { hours, time: end });
}

function machineRows(c: ClusterView, createdAt: number | null, now: number, t: TFunction): Row[] {
  const tp = c.instanceType;
  const running = c.state === "running";
  const left = terminatesIn(c, now);
  const idle = minutesSince(c.lastActivity, now);
  const envNames = Object.keys(c.env ?? {});
  const initLines = c.initScript?.trim() ? c.initScript.trim().split("\n").length : 0;
  const tags = Object.entries(c.tags ?? {});
  return [
    [t("Machine"), tp?.name ?? t("unknown")],
    [t("vCPU"), tp ? String(tp.vcpus) : "—"],
    [t("Memory"), tp ? `${tp.memoryGib} GiB` : "—"],
    [t("Market"), marketLabel(c, t)],
    [t("Disk"), c.volumeGb ? `${c.volumeGb} GB` : "—"],
    [
      t("Auto-terminate"),
      left !== null
        ? t("{{n}} min idle · terminates in {{left}} min if idle", { n: c.autoTerminateMinutes, left })
        : t("{{n}} min idle", { n: c.autoTerminateMinutes }),
    ],
    [t("Time limit"), timeLimit(c, t)],
    [t("Uptime"), running ? formatMinutes(minutesSince(c.startedAt, now) ?? 0) : "—"],
    [t("Idle"), running && idle !== null ? formatMinutes(idle) : "—"],
    [t("Public IP"), c.publicIp ?? "—"],
    [t("Notebooks attached"), String(c.notebooks.length)],
    [t("Libraries"), c.libraries ? String(c.libraries.length) : "—"],
    [t("Environment"), envNames.length ? envNames.join(", ") : "—"],
    [t("Init script"), initLines ? t("{{n}} lines", { n: initLines }) : t("none")],
    [
      t("Tags"),
      tags.length ? (
        <Box key="tags" sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
          {tags.map(([k, v]) => (
            <Chip key={k} size="small" variant="outlined" label={`${k}=${v}`} />
          ))}
        </Box>
      ) : (
        "—"
      ),
    ],
    [t("Default"), c.isDefault ? t("yes") : t("no")],
    ...(c.owner ? [[t("Created by"), c.owner] as Row] : []),
    [t("Created"), createdAt ? `${new Date(createdAt).toLocaleString()} (${formatRelative(createdAt, now)})` : "—"],
    ...(c.error ? [[t("Error"), <Box component="span" key="error" sx={{ color: "error.main" }}>{c.error}</Box>] as Row] : []),
  ];
}

function localRows(c: ClusterView, kernels: number, t: TFunction): Row[] {
  return [
    [t("Machine"), t("this machine (development only)")],
    [t("Notebooks attached"), String(c.notebooks.length)],
    [t("Kernels running"), String(kernels)],
    [t("Default"), c.isDefault ? t("yes") : t("no")],
  ];
}

/** The machine of a cluster: its size, limits and times. */
export function OverviewTab({ cluster: c, createdAt, now, kernels }: { cluster: ClusterView; createdAt: number | null; now: number; kernels: number }) {
  const { t } = useTranslation();
  const rows = c.kind === "local" ? localRows(c, kernels, t) : machineRows(c, createdAt, now, t);
  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Facts rows={rows} />
    </Paper>
  );
}
