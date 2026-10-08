"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import { DataGrid, type GridColDef } from "@mui/x-data-grid";
import type { HistoryEntry } from "@workhouse/protocol";
import { useRouter } from "next/navigation";

import { PageHeader } from "@/features/shell/PageHeader";
import { LocalTime } from "@/features/shell/LocalTime";
import { formatCount, formatDuration } from "@/lib/format";

type Row = HistoryEntry & { id: number };

const columns: GridColDef<Row>[] = [
  { field: "ts", headerName: "When", width: 180, renderCell: ({ row }) => <LocalTime ms={row.ts * 1000} /> },
  {
    field: "error",
    headerName: "Status",
    width: 96,
    renderCell: ({ row }) => <Chip label={row.error ? "failed" : "ok"} color={row.error ? "error" : "success"} variant="outlined" />,
  },
  {
    field: "query",
    headerName: "Query",
    flex: 1,
    minWidth: 300,
    renderCell: ({ row }) => (
      <Box title={row.error ?? row.query} sx={{ fontFamily: "'JetBrains Mono Variable', monospace", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }}>
        {row.query.replace(/\s+/g, " ")}
      </Box>
    ),
  },
  { field: "source", headerName: "Source", width: 220 },
  { field: "rows", headerName: "Rows", width: 110, align: "right", headerAlign: "right", valueFormatter: (v: number | null) => (v == null ? "" : formatCount(v)) },
  { field: "elapsed_ms", headerName: "Time", width: 100, align: "right", headerAlign: "right", valueFormatter: (v: number) => formatDuration(v) },
];

export function HistoryTable({ entries }: { entries: HistoryEntry[] }) {
  const router = useRouter();
  const rows: Row[] = entries.map((e, i) => ({ ...e, id: i }));
  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <PageHeader title="Query history" subtitle="Every query run in this workspace (click one to open it in the SQL editor)" />
      <Box sx={{ flex: 1, minHeight: 0, p: 2 }}>
        <DataGrid
          rows={rows}
          columns={columns}
          density="compact"
          disableRowSelectionOnClick
          onRowClick={({ row }) => router.push(`/sql?q=${encodeURIComponent(row.query)}`)}
          initialState={{ pagination: { paginationModel: { pageSize: 50, page: 0 } } }}
          pageSizeOptions={[25, 50, 100]}
          sx={{ bgcolor: "background.paper", "& .MuiDataGrid-row": { cursor: "pointer" } }}
        />
      </Box>
    </Box>
  );
}
