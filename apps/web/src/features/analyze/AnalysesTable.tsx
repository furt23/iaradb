"use client";

import Box from "@mui/material/Box";
import { DataGrid, type GridColDef } from "@mui/x-data-grid";
import { useRouter } from "next/navigation";

import { LocalTime } from "@/features/shell/LocalTime";
import { formatCount, formatDuration } from "@/lib/format";

import type { AnalysisSummary } from "./types";

const columns: GridColDef<AnalysisSummary>[] = [
  { field: "at", headerName: "When", width: 180, renderCell: ({ row }) => <LocalTime ms={row.at} /> },
  {
    field: "preview",
    headerName: "Query",
    flex: 1,
    minWidth: 300,
    renderCell: ({ row }) => (
      <Box title={row.preview} sx={{ fontFamily: "'JetBrains Mono Variable', monospace", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {row.preview}
      </Box>
    ),
  },
  { field: "elapsed_ms", headerName: "Time", width: 110, align: "right", headerAlign: "right", valueFormatter: (v: number) => formatDuration(v) },
  { field: "rows", headerName: "Rows", width: 110, align: "right", headerAlign: "right", valueFormatter: (v: number | null) => (v == null ? "" : formatCount(v)) },
];

/** The recent analyses; a click opens one. */
export function AnalysesTable({ analyses }: { analyses: AnalysisSummary[] }) {
  const router = useRouter();
  return (
    <DataGrid
      rows={analyses}
      columns={columns}
      density="compact"
      disableRowSelectionOnClick
      onRowClick={({ row }) => router.push(`/analyze/${row.id}`)}
      initialState={{ pagination: { paginationModel: { pageSize: 25, page: 0 } } }}
      pageSizeOptions={[25, 50, 100]}
      sx={{ bgcolor: "background.paper", "& .MuiDataGrid-row": { cursor: "pointer" } }}
    />
  );
}
