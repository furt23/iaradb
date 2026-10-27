"use client";

import Box from "@mui/material/Box";
import { DataGrid, type GridColDef, type GridPaginationModel, type GridSortModel } from "@mui/x-data-grid";
import type { CellValue, ResultMeta, ResultPage, SortKey } from "@iara/protocol";
import { useEffect, useMemo, useRef, useState } from "react";

import { useNotify } from "@/features/shell/notify";
import { isNumericType, typeLabel } from "@/lib/format";
import { fetchResultPage } from "@/server/actions/kernels";
import type { ActionResult } from "@/server/result";

import { fetchArrowPage } from "./arrowPage";

type Row = { id: number } & Record<string, CellValue>;

/** A page over Arrow, else (a kernel too old to make one) the JSON page. */
async function loadPage(kernelKey: string, id: string, offset: number, limit: number, sort: SortKey[]): Promise<ActionResult<ResultPage>> {
  try {
    const page = await fetchArrowPage(kernelKey, id, offset, limit, sort);
    if (page !== "unsupported") return { ok: true, data: page };
  } catch (e) {
    return { ok: false, error: { type: "Error", message: (e as Error).message } };
  }
  return fetchResultPage(kernelKey, id, offset, limit, sort);
}

function toRows(page: ResultPage): Row[] {
  return page.rows.map((r, i) => {
    const row: Row = { id: page.offset + i };
    r.forEach((v, c) => (row[`c${c}`] = v));
    return row;
  });
}

/** Room for the header and typical values of a column type. */
function minWidthOf(name: string, type: string): number {
  const byType = isNumericType(type) ? 100 : type.startsWith("date") || type.startsWith("timestamp") ? 120 : 140;
  return Math.max(byType, Math.min(240, name.length * 8 + 32));
}

function display(v: CellValue): string {
  if (v === null) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 44;
const FOOTER_HEIGHT = 52;

/** Grid height for the visible rows, up to `max`. */
function fitHeight(rows: number, max: number): number {
  return Math.min(max, HEADER_HEIGHT + Math.max(rows, 1) * ROW_HEIGHT + FOOTER_HEIGHT + 2);
}

/** A result held by a kernel, paged and sorted on the server. */
export function ResultTable({ kernelKey, meta, height = 360 }: { kernelKey: string; meta: ResultMeta; height?: number }) {
  const notify = useNotify();
  const [page, setPage] = useState<ResultPage>(meta.page);
  const [pagination, setPagination] = useState<GridPaginationModel>({ page: 0, pageSize: 100 });
  const [sort, setSort] = useState<GridSortModel>([]);
  const [loading, setLoading] = useState(false);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    let live = true;
    setLoading(true);
    const keys = sort.map((s) => ({ column: meta.columns[Number(s.field.slice(1))].name, descending: s.sort === "desc" }));
    loadPage(kernelKey, meta.id, pagination.page * pagination.pageSize, pagination.pageSize, keys).then((r) => {
      if (!live) return;
      setLoading(false);
      if (r.ok) setPage(r.data);
      else notify(r.error.message, "error");
    });
    return () => {
      live = false;
    };
  }, [kernelKey, meta, pagination, sort, notify]);

  const columns = useMemo<GridColDef<Row>[]>(
    () =>
      meta.columns.map((c, i) => {
        const numeric = isNumericType(c.type);
        return {
          field: `c${i}`,
          headerName: c.name,
          description: `${c.name}: ${c.type}`,
          minWidth: minWidthOf(c.name, c.type),
          flex: 1,
          align: numeric ? "right" : "left",
          headerAlign: numeric ? "right" : "left",
          valueFormatter: (v: CellValue) => display(v),
          renderHeader: () => (
            <Box sx={{ lineHeight: 1.15, overflow: "hidden" }}>
              <Box sx={{ fontWeight: 650, fontSize: 12.5 }}>{c.name}</Box>
              <Box sx={{ fontSize: 10.5, color: "text.disabled" }}>{typeLabel(c.type)}</Box>
            </Box>
          ),
        } satisfies GridColDef<Row>;
      }),
    [meta.columns],
  );

  return (
    <Box sx={{ height: fitHeight(page.rows.length, height), width: "100%", "--mono": "'JetBrains Mono Variable', monospace" }}>
      <DataGrid
        rows={toRows(page)}
        columns={columns}
        rowCount={page.total}
        loading={loading}
        paginationMode="server"
        sortingMode="server"
        paginationModel={pagination}
        onPaginationModelChange={setPagination}
        sortModel={sort}
        onSortModelChange={setSort}
        pageSizeOptions={[25, 50, 100]}
        rowHeight={ROW_HEIGHT}
        columnHeaderHeight={HEADER_HEIGHT}
        disableRowSelectionOnClick
        disableColumnMenu
        sx={{
          border: 0,
          fontFamily: "'JetBrains Mono Variable', monospace",
          fontSize: 12.5,
          backgroundColor: "transparent",
          "& .MuiDataGrid-columnHeaders": { fontFamily: "inherit" },
          "& .MuiDataGrid-columnHeader, & .MuiDataGrid-filler, & .MuiDataGrid-scrollbarFiller": {
            backgroundColor: "transparent",
            borderTop: "1px solid",
            borderBottom: "1px solid",
            borderColor: "text.primary",
          },
          "& .MuiDataGrid-columnSeparator": { display: "none" },
          "& .MuiDataGrid-cell": { borderColor: "divider" },
          "& .MuiDataGrid-row:hover": { backgroundColor: "action.hover" },
          "& .MuiDataGrid-footerContainer": { borderColor: "divider" },
        }}
      />
    </Box>
  );
}
