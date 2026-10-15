"use client";

import { BarChart } from "@mui/x-charts/BarChart";
import { LineChart } from "@mui/x-charts/LineChart";
import { ScatterChart } from "@mui/x-charts/ScatterChart";
import type { ChartData, ChartSpec } from "@iara/protocol";
import { useMemo } from "react";

import { formatCompact } from "@/lib/format";

import { isTemporalType, toCategorical, toPoints } from "./chartSpec";

const MARGIN = { left: 8, right: 16, top: 16, bottom: 8 };
/** values as 35K, 1.2M: short enough for the axis */
const Y_AXIS = [{ width: 56, valueFormatter: (v: number | null) => (v === null ? "" : formatCompact(v)), tickLabelStyle: { fontSize: 11 } }];

/** The chart itself, from the kernel's points. */
export function ChartCanvas({ data, spec, height, xType }: { data: ChartData; spec: ChartSpec; height: number; xType: string }) {
  const categorical = useMemo(() => (spec.kind === "scatter" ? null : toCategorical(data, spec)), [data, spec]);
  const points = useMemo(() => (spec.kind === "scatter" ? toPoints(data, spec) : null), [data, spec]);
  const single = (categorical?.series.length ?? points?.length ?? 0) <= 1;
  const slotProps = { legend: { sx: { fontSize: 12 } } };

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
  if (spec.kind === "bar" || spec.kind === "histogram") {
    return (
      <BarChart
        height={height}
        margin={MARGIN}
        hideLegend={single}
        skipAnimation
        xAxis={[{ scaleType: "band", data: categories, label: spec.x, tickLabelStyle: { fontSize: 11 } }]}
        series={series.map((s) => ({ label: s.label, data: s.data, stack: spec.kind === "histogram" ? "bins" : undefined }))}
        yAxis={Y_AXIS}
        slotProps={slotProps}
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
      xAxis={[
        {
          scaleType: time ? "time" : typeof categories[0] === "number" ? "linear" : "point",
          data: time ? categories.map((c) => new Date(c)) : categories,
          label: spec.x,
          tickLabelStyle: { fontSize: 11 },
        },
      ]}
      series={series.map((s) => ({ label: s.label, data: s.data, area: spec.kind === "area", showMark: categories.length <= 40, connectNulls: true }))}
      yAxis={Y_AXIS}
      slotProps={slotProps}
    />
  );
}
