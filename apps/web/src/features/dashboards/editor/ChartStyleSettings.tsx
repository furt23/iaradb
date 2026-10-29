"use client";

import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { ChartKind } from "@iara/protocol";
import { useTranslation } from "react-i18next";

import type { ChartStyle, ChartWidget, SeriesStyle } from "@/lib/dashboards/types";

import { NumberFormatFields } from "./NumberFormatFields";

/** The kinds whose value columns can each sit on the right axis or be drawn as bars or a line. */
const SERIES_KINDS: ChartKind[] = ["bar", "line", "area"];

/** The style without its empty parts, and without series of columns the chart no longer has (undefined when nothing is left). */
function tidy(style: ChartStyle, y: string[]): ChartStyle | undefined {
  const out: ChartStyle = {};
  const series: Record<string, SeriesStyle> = {};
  for (const col of y) {
    const s = style.series?.[col];
    const kept: SeriesStyle = {};
    if (s?.axis) kept.axis = s.axis;
    if (s?.as) kept.as = s.as;
    if (Object.keys(kept).length) series[col] = kept;
  }
  if (Object.keys(series).length) out.series = series;
  if (style.labels) out.labels = true;
  if (style.format) out.format = style.format;
  // the right axis' format goes with the last series on it
  if (style.right_format && Object.values(series).some((s) => s.axis === "right")) out.right_format = style.right_format;
  return Object.keys(out).length ? out : undefined;
}

/** How a chart is drawn: its data labels, its value formats, and per value column its axis and kind. Edits go to `onChange` as the widget. */
export function ChartStyleSettings({ widget, onChange }: { widget: ChartWidget; onChange(widget: ChartWidget): void }) {
  const { t } = useTranslation();
  const { spec } = widget;
  const style = widget.style ?? {};
  const series = style.series ?? {};
  // the value columns drawn: the widget's measures when it has them
  const drawn = widget.measures?.length ? widget.measures : spec.y;
  const perSeries = SERIES_KINDS.includes(spec.kind) && !spec.group && drawn.length >= 2;
  const rightAxis = drawn.some((y) => series[y]?.axis === "right");

  const set = (next: ChartStyle) => onChange({ ...widget, style: tidy(next, drawn) });
  const setSeries = (y: string, change: SeriesStyle) => set({ ...style, series: { ...series, [y]: { ...series[y], ...change } } });

  return (
    <Stack spacing={2}>
      <FormControlLabel
        control={<Switch size="small" checked={!!style.labels} onChange={(_, v) => set({ ...style, labels: v })} />}
        label={t("Data labels")}
      />
      {spec.kind !== "scatter" && <NumberFormatFields label={t("Values")} value={style.format} onChange={(format) => set({ ...style, format })} />}
      {perSeries &&
        drawn.map((y) => (
          <Stack key={y} spacing={1}>
            <Typography sx={{ fontSize: 12, overflowWrap: "anywhere" }}>{y}</Typography>
            <Stack direction="row" spacing={1}>
              <TextField
                select
                size="small"
                fullWidth
                label={t("Axis")}
                value={series[y]?.axis ?? "left"}
                onChange={(e) => setSeries(y, { axis: e.target.value === "right" ? "right" : undefined })}
              >
                <MenuItem value="left">{t("Left")}</MenuItem>
                <MenuItem value="right">{t("Right")}</MenuItem>
              </TextField>
              <TextField
                select
                size="small"
                fullWidth
                label={t("Draw as")}
                value={series[y]?.as ?? "default"}
                onChange={(e) => setSeries(y, { as: e.target.value === "default" ? undefined : (e.target.value as SeriesStyle["as"]) })}
              >
                <MenuItem value="default">{t("Chart default")}</MenuItem>
                <MenuItem value="bar">{t("Bars")}</MenuItem>
                <MenuItem value="line">{t("Line")}</MenuItem>
              </TextField>
            </Stack>
          </Stack>
        ))}
      {rightAxis && <NumberFormatFields label={t("Right axis")} value={style.right_format} onChange={(right_format) => set({ ...style, right_format })} />}
    </Stack>
  );
}
