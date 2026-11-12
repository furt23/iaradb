"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { CellValue, ChartAgg, ChartData, ChartSpec } from "@iara/protocol";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { formatNumber, numberLocale } from "@/lib/dashboards/numberFormat";
import type { ChartStyle, NumberFormat, PickValue } from "@/lib/dashboards/types";
import { formatCompact } from "@/lib/format";

import { numberOf, pickOf, toCategorical, toPoints } from "./chartSpec";
import { EChart } from "./echarts/EChart";
import { gaugeOption } from "./echarts/looks";
import { chartOption, pickModeOf } from "./echarts/options";
import { useChartColors } from "./echarts/palette";
import { ownColor, seriesColors } from "./echarts/parts";

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

/**
 * The chart itself, from the kernel's points. With `onPick`, a click on a
 * category of a bar, line, area or pie chart calls it with the category's x
 * value (undefined when the click is on the one that is `picked`: it clears);
 * `picked` (undefined: none) marks that category when the chart has one series.
 * `caption` (a counter's): replaces the line under its number.
 */
export function ChartCanvas({
  data,
  spec,
  height,
  xType,
  style,
  onPick,
  picked,
  caption,
  formats,
}: {
  data: ChartData;
  spec: ChartSpec;
  height: number;
  xType: string;
  style?: ChartStyle;
  onPick?(value: PickValue | undefined): void;
  picked?: PickValue;
  caption?: string;
  /** each series' number format, where it has its own: its tooltip and labels use it */
  formats?: Record<string, NumberFormat>;
}) {
  const { t, i18n } = useTranslation();
  const locale = numberLocale(i18n.language);
  const colors = useChartColors();
  const counter = spec.kind === "counter";
  const gauge = counter && style?.look === "gauge";
  const categorical = useMemo(() => (counter || spec.kind === "scatter" ? null : toCategorical(data, spec)), [data, spec, counter]);
  const points = useMemo(() => (spec.kind === "scatter" ? toPoints(data, spec) : null), [data, spec]);
  const pickable = onPick !== undefined && categorical !== null && spec.kind !== "histogram";
  const at = pickable && picked !== undefined ? categorical.raw.indexOf(picked) : -1;
  const option = useMemo(() => {
    if (gauge) {
      const [value, target] = data.rows[0] ?? [];
      return gaugeOption({ value: numberOf(value), target: numberOf(target), name: caption ?? spec.y[0] ?? "", style, colors, palette: seriesColors({ style, colors }), locale });
    }
    return counter ? null : chartOption({ spec, categorical, points, xType, style, colors, picked: at, locale, formats });
  }, [gauge, counter, data, caption, spec, categorical, points, xType, style, colors, at, locale, formats]);

  if (!option) {
    const raw = data.rows[0]?.[0] ?? null;
    const value = numberOf(raw) ?? raw;
    const own = caption ? ownColor(style, caption)?.color : undefined;
    return (
      <Box sx={{ height, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 0.5 }}>
        <Typography sx={{ fontSize: 48, fontWeight: 600, lineHeight: 1.1, fontVariantNumeric: "tabular-nums", ...(own && { color: own }) }}>
          {typeof value === "number" && style?.format ? formatNumber(value, style.format, locale) : counterText(value)}
        </Typography>
        <Typography sx={{ fontSize: 12, color: "text.secondary" }}>{caption ?? t(COUNTER_CAPTIONS[spec.agg], { column: spec.y[0] })}</Typography>
      </Box>
    );
  }
  return (
    <EChart
      option={option}
      height={height}
      pickBy={pickModeOf(spec.kind, style?.look)}
      onPick={
        pickable
          ? (i) => {
              const value = pickOf(categorical, i);
              if (value !== undefined) onPick(value === picked ? undefined : value);
            }
          : undefined
      }
    />
  );
}
