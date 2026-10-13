"use client";

import ExpandMore from "@mui/icons-material/ExpandMore";
import HistoryOutlined from "@mui/icons-material/HistoryOutlined";
import TerminalOutlined from "@mui/icons-material/TerminalOutlined";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Collapse from "@mui/material/Collapse";
import IconButton from "@mui/material/IconButton";
import TableCell from "@mui/material/TableCell";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import type { DeltaCommit } from "@workhouse/protocol";
import Link from "next/link";
import { useState } from "react";

import { prettyValues, summariseMetrics, versionQuery } from "@/lib/deltaHistory";
import { formatRelative } from "@/lib/format";

import { sqlHref } from "./links";

const MONO = "'JetBrains Mono Variable', monospace";

function Json({ title, values }: { title: string; values: Record<string, string> }) {
  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Box sx={{ color: "text.disabled", fontSize: 10, textTransform: "uppercase", mb: 0.5 }}>{title}</Box>
      <Box component="pre" sx={{ m: 0, fontFamily: MONO, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
        {Object.keys(values).length ? prettyValues(values) : "–"}
      </Box>
    </Box>
  );
}

/** One commit of a Delta table: summary, actions, and parameters on expansion. */
export function HistoryRow({ commit, table, current, onRestore }: { commit: DeltaCommit; table: string; current: boolean; onRestore(version: number): void }) {
  const [open, setOpen] = useState(false);
  const metrics = summariseMetrics(commit.operation_metrics);
  return (
    <>
      <TableRow hover sx={{ "& > td": { borderBottom: open ? 0 : undefined } }}>
        <TableCell sx={{ width: 40, px: 1 }}>
          <IconButton size="small" aria-label={open ? "collapse" : "expand"} onClick={() => setOpen(!open)}>
            <ExpandMore fontSize="small" sx={{ transform: open ? "none" : "rotate(-90deg)", transition: "transform .15s" }} />
          </IconButton>
        </TableCell>
        <TableCell sx={{ fontFamily: MONO, fontSize: 12, fontWeight: 650 }}>
          {commit.version}
          {current && <Chip label="current" size="small" color="primary" variant="outlined" sx={{ ml: 1, height: 18, fontSize: 10 }} />}
        </TableCell>
        <Tooltip title={new Date(commit.timestamp).toLocaleString()} enterDelay={400}>
          <TableCell sx={{ whiteSpace: "nowrap" }}>{formatRelative(commit.timestamp)}</TableCell>
        </Tooltip>
        <TableCell>{commit.operation ?? "–"}</TableCell>
        <TableCell sx={{ fontFamily: MONO, fontSize: 12, color: "text.secondary" }}>{metrics.join(" · ") || "–"}</TableCell>
        <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
          <Tooltip title={`Query version ${commit.version}`}>
            <IconButton size="small" aria-label={`query version ${commit.version}`} component={Link} href={sqlHref(versionQuery(table, commit.version))}>
              <TerminalOutlined fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={current ? "This is the current version" : `Restore to version ${commit.version}`}>
            <span>
              <IconButton size="small" aria-label={`restore version ${commit.version}`} disabled={current} onClick={() => onRestore(commit.version)}>
                <HistoryOutlined fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={6} sx={{ py: 0, border: open ? undefined : 0 }}>
          <Collapse in={open} unmountOnExit>
            <Box sx={{ display: "flex", gap: 3, py: 1.5 }}>
              <Json title="Parameters" values={commit.operation_parameters} />
              <Json title="Metrics" values={commit.operation_metrics} />
              {commit.engine_info && <Box sx={{ color: "text.secondary", fontSize: 12 }}>{commit.engine_info}</Box>}
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}
