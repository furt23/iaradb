"use client";

import Chip from "@mui/material/Chip";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import type { TableInfo } from "@iara/protocol";

import { formatCount, typeLabel } from "@/lib/format";

const MONO = "'JetBrains Mono Variable', monospace";
const VALUE = { fontFamily: MONO, fontSize: 12, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

function show(v: unknown): string {
  return v === null || v === undefined ? "–" : String(v);
}

/** A table's columns with their types and Parquet statistics. */
export function ColumnsTable({ info }: { info: TableInfo }) {
  const stats = new Map(info.stats.map((s) => [s.column, s]));
  return (
    <Table size="small" stickyHeader aria-label={`columns of ${info.name}`}>
      <TableHead>
        <TableRow>
          <TableCell sx={{ width: 40, color: "text.disabled" }}>#</TableCell>
          <TableCell>Column</TableCell>
          <TableCell>Type</TableCell>
          <TableCell>Min</TableCell>
          <TableCell>Max</TableCell>
          <TableCell align="right">Nulls</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {info.columns.map((c, i) => {
          const s = stats.get(c.name);
          const approx = s && !s.exact ? " (from part of the files)" : "";
          return (
            <TableRow key={c.name} hover>
              <TableCell sx={{ color: "text.disabled", fontFamily: MONO, fontSize: 11 }}>{i + 1}</TableCell>
              <TableCell sx={{ fontWeight: 650 }}>{c.name}</TableCell>
              <TableCell>
                <Chip label={typeLabel(c.type)} title={c.type} variant="outlined" size="small" sx={{ fontFamily: MONO, fontWeight: 500 }} />
                {c.nullable === false && <Chip label="NOT NULL" size="small" sx={{ ml: 0.75, height: 18, fontSize: 10 }} />}
              </TableCell>
              <Tooltip title={`${show(s?.min)}${approx}`} enterDelay={500}>
                <TableCell sx={VALUE}>{show(s?.min)}</TableCell>
              </Tooltip>
              <Tooltip title={`${show(s?.max)}${approx}`} enterDelay={500}>
                <TableCell sx={VALUE}>{show(s?.max)}</TableCell>
              </Tooltip>
              <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12 }}>
                {s ? formatCount(s.nulls) : "–"}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
