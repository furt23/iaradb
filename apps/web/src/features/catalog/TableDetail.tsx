"use client";

import TerminalOutlined from "@mui/icons-material/TerminalOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import type { CellOutput, TableInfo } from "@workhouse/protocol";
import Link from "next/link";

import { OutputView } from "@/features/results/OutputView";
import { PageBody, PageHeader } from "@/features/shell/PageHeader";
import { formatBytes, formatCount } from "@/lib/format";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Typography variant="overline" sx={{ color: "text.disabled", fontSize: 10 }}>
        {label}
      </Typography>
      <Typography sx={{ fontWeight: 700, fontSize: 18 }}>{value}</Typography>
    </Box>
  );
}

function show(v: unknown): string {
  return v === null || v === undefined ? "–" : String(v);
}

export function TableDetail({ info, preview }: { info: TableInfo; preview: CellOutput | null }) {
  const stats = new Map(info.stats.map((s) => [s.column, s]));
  const query = `select *\nfrom ${info.name}\nlimit 100`;
  return (
    <>
      <PageHeader
        title={info.name}
        subtitle={`${info.format} · ${info.path}`}
        actions={
          <Button variant="outlined" startIcon={<TerminalOutlined />} component={Link} href={`/sql?q=${encodeURIComponent(query)}`}>
            Query
          </Button>
        }
      />
      <PageBody>
        <Box sx={{ display: "flex", gap: 5, mb: 3 }}>
          <Stat label="Rows" value={formatCount(info.num_rows)} />
          <Stat label="Columns" value={String(info.columns.length)} />
          <Stat label="Files" value={String(info.files)} />
          <Stat label="Size" value={formatBytes(info.bytes)} />
        </Box>
        <Paper variant="outlined" sx={{ mb: 3, overflow: "hidden" }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Column</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Min</TableCell>
                <TableCell>Max</TableCell>
                <TableCell align="right">Nulls</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {info.columns.map((c) => {
                const s = stats.get(c.name);
                return (
                  <TableRow key={c.name} hover>
                    <TableCell sx={{ fontWeight: 650 }}>{c.name}</TableCell>
                    <TableCell>
                      <Chip label={c.type} variant="outlined" sx={{ fontFamily: "'JetBrains Mono Variable', monospace", fontWeight: 500 }} />
                    </TableCell>
                    <TableCell sx={{ fontFamily: "'JetBrains Mono Variable', monospace", fontSize: 12, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{show(s?.min)}</TableCell>
                    <TableCell sx={{ fontFamily: "'JetBrains Mono Variable', monospace", fontSize: 12, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{show(s?.max)}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: "'JetBrains Mono Variable', monospace", fontSize: 12 }}>
                      {s ? formatCount(s.nulls) : "–"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Paper>
        <Typography variant="h4" sx={{ mb: 1 }}>
          Preview
        </Typography>
        <Paper variant="outlined" sx={{ overflow: "hidden" }}>
          {preview ? <OutputView output={preview} kernelKey="workspace" tableHeight={420} /> : <Typography sx={{ p: 2 }}>No preview.</Typography>}
        </Paper>
      </PageBody>
    </>
  );
}
