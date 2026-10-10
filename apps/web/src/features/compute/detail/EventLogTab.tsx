"use client";

import Chip, { type ChipProps } from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";

import { formatRelative } from "@/lib/format";
import type { ClusterEvent, ClusterEventKind } from "@/server/compute/events";

const COLORS: Partial<Record<ClusterEventKind, ChipProps["color"]>> = {
  running: "success",
  error: "error",
  "auto-terminate": "warning",
};

/** What happened to a cluster, newest first. */
export function EventLogTab({ events, now }: { events: ClusterEvent[]; now: number }) {
  if (!events.length) return <Typography sx={{ color: "text.secondary" }}>No events yet.</Typography>;
  return (
    <Paper variant="outlined">
      <Table size="small" aria-label="event log">
        <TableHead>
          <TableRow>
            <TableCell>When</TableCell>
            <TableCell>Event</TableCell>
            <TableCell>Details</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {events.map((e, i) => (
            <TableRow key={`${e.at}-${i}`}>
              <TableCell title={new Date(e.at).toLocaleString()} sx={{ whiteSpace: "nowrap" }}>
                {formatRelative(e.at, now)}
              </TableCell>
              <TableCell>
                <Chip size="small" variant="outlined" color={COLORS[e.kind] ?? "default"} label={e.kind} />
              </TableCell>
              <TableCell sx={{ overflowWrap: "anywhere" }}>{e.message}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Paper>
  );
}
