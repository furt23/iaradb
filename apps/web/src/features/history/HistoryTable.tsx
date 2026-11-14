"use client";

import Search from "@mui/icons-material/Search";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import InputAdornment from "@mui/material/InputAdornment";
import TextField from "@mui/material/TextField";
import { DataGrid, type GridColDef } from "@mui/x-data-grid";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnalyzeIconButton } from "@/features/analyze/AnalyzeIconButton";
import { PageHeader } from "@/features/shell/PageHeader";
import { LocalTime } from "@/features/shell/LocalTime";
import { formatCount, formatDuration } from "@/lib/format";
import type { QueryLogEntry } from "@/lib/system/types";

export function HistoryTable({ entries }: { entries: QueryLogEntry[] }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [filter, setFilter] = useState("");

  const columns = useMemo<GridColDef<QueryLogEntry>[]>(
    () => [
      { field: "ts", headerName: t("When"), width: 180, renderCell: ({ row }) => <LocalTime ms={row.ts} /> },
      { field: "user", headerName: t("User"), width: 200 },
      {
        field: "error",
        headerName: t("Status"),
        width: 96,
        renderCell: ({ row }) => <Chip label={row.error ? "failed" : "ok"} color={row.error ? "error" : "success"} variant="outlined" />,
      },
      {
        field: "query",
        headerName: t("Query"),
        flex: 1,
        minWidth: 300,
        renderCell: ({ row }) => (
          <Box title={row.error ?? row.query} sx={{ fontFamily: "'JetBrains Mono Variable', monospace", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }}>
            {row.query.replace(/\s+/g, " ")}
          </Box>
        ),
      },
      { field: "source", headerName: t("Source"), width: 220 },
      { field: "rows", headerName: t("Rows"), width: 110, align: "right", headerAlign: "right", valueFormatter: (v: number | null) => (v == null ? "" : formatCount(v)) },
      { field: "elapsed_ms", headerName: t("Time"), width: 100, align: "right", headerAlign: "right", valueFormatter: (v: number) => formatDuration(v) },
      {
        field: "analyze",
        headerName: "",
        width: 64,
        sortable: false,
        filterable: false,
        renderCell: ({ row }) => (row.kind === "sql" ? <AnalyzeIconButton query={row.query} source={row.source} /> : null),
      },
    ],
    [t],
  );

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? entries.filter((r) => r.query.toLowerCase().includes(f) || r.source.toLowerCase().includes(f) || (r.user ?? "").toLowerCase().includes(f) || (r.error ?? "").toLowerCase().includes(f)) : entries;
  }, [entries, filter]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <PageHeader
        title={t("Query history")}
        subtitle={t("Click a query to open it in the SQL editor.")}
        actions={
          <TextField
            size="small"
            placeholder={t("Filter queries, sources, errors")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            slotProps={{
              htmlInput: { "aria-label": "filter history" },
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <Search sx={{ fontSize: 18 }} />
                  </InputAdornment>
                ),
              },
            }}
            sx={{ width: 300 }}
          />
        }
      />
      <Box sx={{ flex: 1, minHeight: 0, p: 2 }}>
        <DataGrid
          rows={rows}
          columns={columns}
          density="compact"
          disableRowSelectionOnClick
          onRowClick={({ row }) => {
            if (row.kind === "sql") router.push(`/sql?q=${encodeURIComponent(row.query)}`);
          }}
          getRowClassName={({ row }) => (row.kind === "sql" ? "sql-run" : "")}
          initialState={{ pagination: { paginationModel: { pageSize: 50, page: 0 } } }}
          pageSizeOptions={[25, 50, 100]}
          sx={{ bgcolor: "background.paper", "& .MuiDataGrid-row.sql-run": { cursor: "pointer" } }}
        />
      </Box>
    </Box>
  );
}

