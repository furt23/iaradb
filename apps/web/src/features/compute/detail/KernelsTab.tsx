"use client";

import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { useState } from "react";

import { useGuard } from "@/features/shell/notify";
import { fileHref } from "@/features/workbench/WorkbenchProvider";
import { unwrap } from "@/lib/action";
import { formatRelative } from "@/lib/format";
import { type ClusterKernel, restartClusterKernel, stopClusterKernel } from "@/server/actions/clusters";

import { type KernelWhat, kernelWhat } from "./kernelWhat";

function WhatCell({ what }: { what: KernelWhat }) {
  if (what.kind === "notebook") return <Link href={fileHref(what.path)}>{what.path}</Link>;
  if (what.kind === "job") return <>Job run {what.run}</>;
  return <>Workspace (catalog, SQL editor, history)</>;
}

/** The kernels running on a cluster, with their state and how to restart or stop them. */
export function KernelsTab({ kernels, now, onChanged }: { kernels: ClusterKernel[]; now: number; onChanged(): Promise<unknown> }) {
  const guard = useGuard();
  const [pending, setPending] = useState<string | null>(null);

  const act = (key: string, task: () => Promise<unknown>) =>
    void guard(async () => {
      setPending(key);
      try {
        await task();
        await onChanged();
      } finally {
        setPending(null);
      }
    });

  if (!kernels.length) {
    return (
      <Typography sx={{ color: "text.secondary" }}>
        No kernel runs on this cluster now. A notebook starts one when it runs; the SQL editor and the catalog share the workspace kernel.
      </Typography>
    );
  }
  return (
    <Paper variant="outlined">
      <Table size="small" aria-label="kernels">
        <TableHead>
          <TableRow>
            <TableCell>Serves</TableCell>
            <TableCell>State</TableCell>
            <TableCell>Started</TableCell>
            <TableCell>Last used</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {kernels.map((k) => {
            const what = kernelWhat(k.key);
            const busy = pending === k.key;
            return (
              <TableRow key={k.key}>
                <TableCell sx={{ overflowWrap: "anywhere" }}>
                  <WhatCell what={what} />
                </TableCell>
                <TableCell>
                  <Chip size="small" variant="outlined" color={k.busy ? "warning" : "success"} label={k.busy ? "busy" : "idle"} />
                </TableCell>
                <TableCell title={new Date(k.startedAt).toLocaleString()} sx={{ whiteSpace: "nowrap" }}>
                  {formatRelative(k.startedAt, now)}
                </TableCell>
                <TableCell title={new Date(k.lastUsed).toLocaleString()} sx={{ whiteSpace: "nowrap" }}>
                  {formatRelative(k.lastUsed, now)}
                </TableCell>
                <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                  <Tooltip title={what.kind === "job" ? "A job run's kernel is not restarted: cancel the run instead" : ""}>
                    <span>
                      <Button
                        size="small"
                        disabled={busy || what.kind === "job"}
                        onClick={() => act(k.key, async () => unwrap(await restartClusterKernel(k.key)))}
                      >
                        Restart
                      </Button>
                    </span>
                  </Tooltip>
                  <Button size="small" color="error" disabled={busy} onClick={() => act(k.key, async () => unwrap(await stopClusterKernel(k.key)))}>
                    Stop
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Paper>
  );
}
