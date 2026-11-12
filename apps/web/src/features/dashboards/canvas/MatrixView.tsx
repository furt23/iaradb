"use client";

import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { toCategorical } from "@/features/results/chart/chartSpec";
import { formatNumber, numberLocale } from "@/lib/dashboards/numberFormat";
import type { ChartWidget, NumberFormat, PickValue, WidgetData } from "@/lib/dashboards/types";

/** How a dashboard table looks, a matrix or a list of rows. */
export const DASH_TABLE_SX = {
  "& .MuiTableCell-root": { fontFamily: "'JetBrains Mono Variable', monospace", fontSize: 12, py: 0.5, whiteSpace: "nowrap", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" },
  // the theme's header is see-through, which a sticky one cannot be
  "& .MuiTableHead-root .MuiTableCell-root": { bgcolor: "background.paper" },
} as const;

/**
 * A chart's data as a table: a row per x and a column per series (the values, or the legend's values when it
 * has one). shortcut: no totals, since a total is not the sum of its cells for an average or a distinct count;
 * upgrade by asking the model for the query without x.
 */
export function MatrixView({
  widget,
  data,
  onPick,
  picked,
}: {
  widget: ChartWidget;
  data: Extract<WidgetData, { kind: "chart" }>;
  onPick?(value: PickValue | undefined): void;
  picked?: PickValue;
}) {
  const { t, i18n } = useTranslation();
  const locale = numberLocale(i18n.language);
  const { categories, raw, series } = useMemo(() => toCategorical(data.data, widget.spec), [data.data, widget.spec]);
  const formatOf = (label: string): NumberFormat | undefined => widget.style?.format ?? data.formats?.[label];
  const heading = widget.style?.x_title ?? widget.spec.x.slice(widget.spec.x.lastIndexOf(".") + 1);
  return (
    <TableContainer sx={{ flex: 1, minHeight: 0 }}>
      <Table size="small" stickyHeader aria-label={widget.title ?? t("Matrix")} sx={DASH_TABLE_SX}>
        <TableHead>
          <TableRow>
            <TableCell>{heading}</TableCell>
            {series.map((s) => (
              <TableCell key={s.label} align="right" title={s.label}>
                {s.label}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {categories.map((category, r) => {
            const value = raw[r];
            const pickable = onPick !== undefined && (typeof value !== "object" || value === null);
            return (
              <TableRow
                key={String(category)}
                hover={pickable}
                selected={pickable && picked !== undefined && value === picked}
                onClick={pickable ? () => onPick(value === picked ? undefined : (value as PickValue)) : undefined}
                sx={pickable ? { cursor: "pointer" } : undefined}
              >
                <TableCell title={String(category)}>{String(category)}</TableCell>
                {series.map((s) => {
                  const v = s.data[r];
                  return (
                    <TableCell key={s.label} align="right">
                      {v === null ? "—" : formatNumber(v, formatOf(s.label), locale)}
                    </TableCell>
                  );
                })}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
