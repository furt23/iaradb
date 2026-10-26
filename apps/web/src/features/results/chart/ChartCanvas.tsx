"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { BarChart } from "@mui/x-charts/BarChart";
import { LineChart } from "@mui/x-charts/LineChart";
import { PieChart } from "@mui/x-charts/PieChart";
import { ScatterChart } from "@mui/x-charts/ScatterChart";
import type { CellValue, ChartAgg, ChartData, ChartSpec } from "@iara/protocol";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { PickValue } from "@/lib/dashboards/types";
import { formatCompact } from "@/lib/format";

import { isTemporalType, pickOf, toCategorical, toPoints } from "./chartSpec";

const MARGIN = { left: 8, right: 16, top: 16, bottom: 8 };
/** values as 35K, 1.2M: short enough for the axis */
const Y_AXIS = [{ width: 56, valueFormatter: (v: number | null) => (v === null ? "" : formatCompact(v)), tickLabelStyle: { fontSize: 11 } }];
/** the line under a counter's number */
const COUNTER_CAPTIONS: Record<ChartAgg, string> = {
  sum: "sum of {{column}}",
  avg: "average of {{column}}",
  min: "minimum of {{column}}",
  max: "maximum of {{column}}",
  count: "rows",
  none: "",
};

/** A counter's number: compact when large, "—" for no value. */
function counterText(v: CellValue): string {
  if (v === null) return "—";
  if (typeof v !== "number") return String(v);
  return Math.abs(v) >= 10_000 ? formatCompact(v) : v.toLocaleString();
}

/** a picked category stands out from the others */
const PICK_SCOPE = { highlight: "item", fade: "global" } as const;

/**
 * The chart itself, from the kernel's points. With `onPick`, a click on a
 * category of a bar, line, area or pie chart calls it with the category's x
 * value (undefined when the click is on the one that is `picked`: it clears);
 * `picked` (undefined: none) marks that category when the chart has one series.
 */
export function ChartCanvas({
  data,
  spec,
  height,
  xType,
  onPick,
  picked,
}: {
  data: ChartData;
  spec: ChartSpec;
  height: number;
  xType: string;
  onPick?(value: PickValue | undefined): void;
  picked?: PickValue;
}) {
  const { t } = useTranslation();
  const categorical = useMemo(() => (spec.kind === "scatter" ? null : toCategorical(data, spec)), [data, spec]);
  const points = useMemo(() => (spec.kind === "scatter" ? toPoints(data, spec) : null), [data, spec]);
  const single = (categorical?.series.length ?? points?.length ?? 0) <= 1;
  const slotProps = { legend: { sx: { fontSize: 12 } } };

  if (spec.kind === "counter") {
    const value = data.rows[0]?.[0] ?? null;
    return (
      <Box sx={{ height, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 0.5 }}>
        <Typography sx={{ fontSize: 48, fontWeight: 600, lineHeight: 1.1, fontVariantNumeric: "tabular-nums" }}>{counterText(value)}</Typography>
        <Typography sx={{ fontSize: 12, color: "text.secondary" }}>{t(COUNTER_CAPTIONS[spec.agg], { column: spec.y[0] })}</Typography>
      </Box>
    );
  }

  if (points) {
    return (
      <ScatterChart
        height={height}
        margin={MARGIN}
        hideLegend={single}
        skipAnimation
        series={points.map((s) => ({ label: s.label, data: s.data, markerSize: 3 }))}
        xAxis={[{ label: spec.x }]}
        yAxis={Y_AXIS}
        slotProps={slotProps}
      />
    );
  }
  const { categories, series } = categorical!;
  const pickable = onPick !== undefined && spec.kind !== "histogram";
  const pick = (i: number | null | undefined) => {
    const value = pickOf(categorical!, i);
    if (value !== undefined) onPick?.(value === picked ? undefined : value);
  };
  const at = picked === undefined ? -1 : categorical!.raw.indexOf(picked);
  // one series only (a pie draws the first): with several, an item is one series' bar or point, not a category
  const mark = pickable ? { highlightScope: PICK_SCOPE } : {};
  const marked = pickable ? { highlightedItem: at >= 0 && (series.length === 1 || spec.kind === "pie") ? { seriesId: "s0", dataIndex: at } : null } : {};
  const clickable = pickable ? { cursor: "pointer" } : undefined;
  if (spec.kind === "pie") {
    const values = series[0]?.data ?? [];
    return (
      <PieChart
        height={height}
        hideLegend={categories.length > 12}
        skipAnimation
        series={[{ id: "s0", data: categories.map((c, i) => ({ id: i, value: values[i] ?? 0, label: String(c) })), ...mark }]}
        slotProps={slotProps}
        sx={clickable}
        onItemClick={pickable ? (_, item) => pick(item.dataIndex) : undefined}
        {...marked}
      />
    );
  }
  if (spec.kind === "bar" || spec.kind === "histogram") {
    return (
      <BarChart
        height={height}
        margin={MARGIN}
        hideLegend={single}
        skipAnimation
        xAxis={[{ scaleType: "band", data: categories, label: spec.x, tickLabelStyle: { fontSize: 11 } }]}
        series={series.map((s, i) => ({ id: `s${i}`, label: s.label, data: s.data, stack: spec.kind === "histogram" ? "bins" : undefined, ...mark }))}
        yAxis={Y_AXIS}
        slotProps={slotProps}
        sx={clickable}
        onAxisClick={pickable ? (_, d) => pick(d?.dataIndex) : undefined}
        {...marked}
      />
    );
  }
  const time = isTemporalType(xType);
  return (
    <LineChart
      height={height}
      margin={MARGIN}
      hideLegend={single}
      skipAnimation
      sx={clickable}
      onAxisClick={pickable ? (_, d) => pick(d?.dataIndex) : undefined}
      {...marked}
      xAxis={[
        {
          scaleType: time ? "time" : typeof categories[0] === "number" ? "linear" : "point",
          data: time ? categories.map((c) => new Date(c)) : categories,
          label: spec.x,
          tickLabelStyle: { fontSize: 11 },
        },
      ]}
      series={series.map((s, i) => ({ id: `s${i}`, label: s.label, data: s.data, area: spec.kind === "area", showMark: categories.length <= 40, connectNulls: true, ...mark }))}
      yAxis={Y_AXIS}
      slotProps={slotProps}
    />
  );
}
