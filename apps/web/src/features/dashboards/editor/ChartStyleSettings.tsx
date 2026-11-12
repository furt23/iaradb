"use client";

import Box from "@mui/material/Box";
import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { ChartKind } from "@iara/protocol";
import { useTranslation } from "react-i18next";

import { toCategorical, toPoints } from "@/features/results/chart/chartSpec";
import { PALETTES, useChartColors } from "@/features/results/chart/echarts/palette";
import { seriesColors } from "@/features/results/chart/echarts/parts";
import { drawnNames } from "@/lib/dashboards/chartFields";
import type { ChartPalette, ChartStyle, ChartWidget, LegendPosition, SeriesStyle, WidgetData } from "@/lib/dashboards/types";

import { ColorField } from "./ColorField";
import { NumberFormatFields } from "./NumberFormatFields";
import { PANEL_HEADING } from "./panelStyle";

/** The kinds whose value columns can each sit on the right axis or be drawn as bars or a line. */
const SERIES_KINDS: ChartKind[] = ["bar", "line", "area"];
const PALETTE_LABELS: Record<ChartPalette, string> = { ocean: "Ocean", sunset: "Sunset", forest: "Forest", berry: "Berry", earth: "Earth", mono: "Single hue" };
const LEGENDS: { value: LegendPosition; label: string }[] = [
  { value: "top", label: "Top" },
  { value: "bottom", label: "Bottom" },
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "none", label: "Hidden" },
];
/** past this many, per-item colors are noise: the palette does the job */
const MAX_COLOR_ITEMS = 24;

/** The style without its empty parts, and without series of columns the chart no longer has (undefined when nothing is left). */
function tidy(style: ChartStyle, y: string[]): ChartStyle | undefined {
  const { series: _series, labels, right_format, colors, ...others } = style;
  const out: ChartStyle = Object.fromEntries(Object.entries(others).filter(([, v]) => v !== undefined));
  const series: Record<string, SeriesStyle> = {};
  for (const col of y) {
    const s = style.series?.[col];
    const kept: SeriesStyle = {};
    if (s?.axis) kept.axis = s.axis;
    if (s?.as) kept.as = s.as;
    if (Object.keys(kept).length) series[col] = kept;
  }
  if (Object.keys(series).length) out.series = series;
  if (labels) out.labels = true;
  if (colors && Object.keys(colors).length) out.colors = colors;
  // the right axis' format goes with the last series on it
  if (right_format && Object.values(series).some((s) => s.axis === "right")) out.right_format = right_format;
  return Object.keys(out).length ? out : undefined;
}

/** What can take a color of its own in this chart: its series, its slices, or its parts. */
export function colorItems(widget: ChartWidget, data: WidgetData | undefined): string[] {
  const { spec, style } = widget;
  if (spec.kind === "counter") return drawnNames(widget).slice(0, 1);
  if (style?.look === "waterfall") return ["Increase", "Decrease", "Total"];
  if (style?.look === "heatmap") return ["Scale"];
  if (data?.kind !== "chart") return [];
  if (spec.kind === "scatter") return toPoints(data.data, spec).map((g) => g.label);
  const c = toCategorical(data.data, spec);
  return spec.kind === "pie" ? c.categories.map(String) : c.series.map((s) => s.label);
}

/** What the colors below the palette are of (an English key for `t`). */
function colorsHeading({ spec, style }: ChartWidget): string {
  if (spec.kind === "counter") return "Number color";
  if (style?.look === "heatmap") return "Scale color";
  if (style?.look === "waterfall") return "Color of each part";
  return spec.kind === "pie" ? "Color of each slice" : "Color of each series";
}

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <Stack spacing={1}>
      <Typography sx={PANEL_HEADING}>{heading}</Typography>
      {children}
    </Stack>
  );
}

/** How a chart is drawn: its colors, legend, axes, labels and number formats, and per value column its axis and kind. Edits go to `onChange` as the widget. */
export function ChartStyleSettings({ widget, data, onChange }: { widget: ChartWidget; data: WidgetData | undefined; onChange(widget: ChartWidget): void }) {
  const { t } = useTranslation();
  const colors = useChartColors();
  const { spec } = widget;
  const style = widget.style ?? {};
  const look = style.look;
  const series = style.series ?? {};
  // the value columns drawn: the widget's fields when it has them
  const fields = drawnNames(widget);
  const drawn = fields.length ? fields : spec.y;
  const horizontal = look === "hbar" || look === "hbar_stacked" || look === "hbar_percent";
  const matrix = look === "matrix";
  const perSeries = SERIES_KINDS.includes(spec.kind) && !spec.group && drawn.length >= 2 && !horizontal && !matrix && look !== "waterfall" && look !== "heatmap";
  const rightAxis = drawn.some((y) => series[y]?.axis === "right");
  const hasAxes = spec.kind !== "pie" && spec.kind !== "counter" && !matrix;
  const palette = seriesColors({ style, colors });
  const items = matrix ? [] : colorItems(widget, data).slice(0, MAX_COLOR_ITEMS);
  // one series draws no legend: there would be nothing for the setting to move
  const hasLegend = !matrix && spec.kind !== "counter" && look !== "treemap" && look !== "funnel" && look !== "waterfall" && look !== "heatmap" && (spec.kind === "pie" || items.length !== 1);

  const set = (next: ChartStyle) => onChange({ ...widget, style: tidy(next, drawn) });
  const setSeries = (y: string, change: SeriesStyle) => set({ ...style, series: { ...series, [y]: { ...series[y], ...change } } });
  const setColor = (label: string, color: string | undefined) => {
    const { [label]: _old, ...rest } = style.colors ?? {};
    set({ ...style, colors: color ? { ...rest, [label]: color } : rest });
  };

  return (
    <Stack spacing={2.5}>
      {!matrix && (
        <Section heading={t("Colors")}>
          <TextField select size="small" fullWidth label={t("Palette")} value={style.palette ?? ""} onChange={(e) => set({ ...style, palette: (e.target.value || undefined) as ChartPalette | undefined })} slotProps={{ inputLabel: { shrink: true }, select: { displayEmpty: true } }}>
            <MenuItem value="">{t("Default")}</MenuItem>
            {(Object.keys(PALETTES) as ChartPalette[]).map((p) => (
              <MenuItem key={p} value={p}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <Box aria-hidden sx={{ display: "flex" }}>
                    {PALETTES[p].slice(0, 5).map((c) => (
                      <Box key={c} sx={{ width: 12, height: 12, bgcolor: c }} />
                    ))}
                  </Box>
                  {t(PALETTE_LABELS[p])}
                </Box>
              </MenuItem>
            ))}
          </TextField>
          {items.length > 0 && <Typography sx={{ fontSize: 12, color: "text.secondary", pt: 0.5 }}>{t(colorsHeading(widget))}</Typography>}
          {items.map((label, i) => {
            const translated = look === "waterfall" || look === "heatmap" ? t(label) : label;
            // a card's number is in the theme's text color until it is given one
            const fallback = spec.kind === "counter" && look !== "gauge" ? undefined : palette[i % palette.length];
            return <ColorField key={label} label={translated} palette={palette} value={style.colors?.[label]} fallback={fallback} inline={items.length === 1} onChange={(color) => setColor(label, color)} />;
          })}
        </Section>
      )}
      {(hasLegend || hasAxes) && (
        <Section heading={t("Layout")}>
          {hasLegend && (
            <TextField select size="small" fullWidth label={t("Legend")} value={style.legend ?? "top"} onChange={(e) => set({ ...style, legend: e.target.value === "top" ? undefined : (e.target.value as LegendPosition) })}>
              {LEGENDS.map((l) => (
                <MenuItem key={l.value} value={l.value}>
                  {t(l.label)}
                </MenuItem>
              ))}
            </TextField>
          )}
          {hasAxes && (
            <>
              <TextField size="small" fullWidth label={t("X axis title")} placeholder={spec.x.slice(spec.x.lastIndexOf(".") + 1)} value={style.x_title ?? ""} onChange={(e) => set({ ...style, x_title: e.target.value || undefined })} slotProps={{ inputLabel: { shrink: true } }} />
              <TextField size="small" fullWidth label={t("Y axis title")} value={style.y_title ?? ""} onChange={(e) => set({ ...style, y_title: e.target.value || undefined })} slotProps={{ inputLabel: { shrink: true } }} />
              <FormControlLabel control={<Switch size="small" checked={style.gridlines !== false} onChange={(_, v) => set({ ...style, gridlines: v ? undefined : false })} />} label={t("Gridlines")} />
            </>
          )}
          {(spec.kind === "line" || spec.kind === "area" || look === "combo") && (
            <FormControlLabel control={<Switch size="small" checked={!!style.smooth} onChange={(_, v) => set({ ...style, smooth: v || undefined })} />} label={t("Smooth lines")} />
          )}
        </Section>
      )}
      <Section heading={t("Values")}>
        {!matrix && spec.kind !== "counter" && <FormControlLabel control={<Switch size="small" checked={!!style.labels} onChange={(_, v) => set({ ...style, labels: v })} />} label={t("Data labels")} />}
        {look === "gauge" && (
          <TextField
            size="small"
            type="number"
            fullWidth
            label={t("Gauge maximum")}
            placeholder={t("Automatic")}
            value={style.gauge_max ?? ""}
            onChange={(e) => {
              const n = Number(e.target.value);
              set({ ...style, gauge_max: n > 0 ? n : undefined });
            }}
            slotProps={{ inputLabel: { shrink: true } }}
          />
        )}
        {spec.kind !== "scatter" && look !== "percent" && look !== "hbar_percent" && <NumberFormatFields label={t("Number format")} value={style.format} onChange={(format) => set({ ...style, format })} />}
      </Section>
      {perSeries && (
        <Section heading={t("Series")}>
          {drawn.map((y) => (
            <Stack key={y} spacing={1}>
              <Typography sx={{ fontSize: 12, overflowWrap: "anywhere" }}>{y}</Typography>
              <Stack direction="row" spacing={1}>
                <TextField select size="small" fullWidth label={t("Axis")} value={series[y]?.axis ?? "left"} onChange={(e) => setSeries(y, { axis: e.target.value === "right" ? "right" : undefined })}>
                  <MenuItem value="left">{t("Left")}</MenuItem>
                  <MenuItem value="right">{t("Right")}</MenuItem>
                </TextField>
                <TextField select size="small" fullWidth label={t("Draw as")} value={series[y]?.as ?? "default"} onChange={(e) => setSeries(y, { as: e.target.value === "default" ? undefined : (e.target.value as SeriesStyle["as"]) })}>
                  <MenuItem value="default">{t("Chart default")}</MenuItem>
                  <MenuItem value="bar">{t("Bars")}</MenuItem>
                  <MenuItem value="line">{t("Line")}</MenuItem>
                </TextField>
              </Stack>
            </Stack>
          ))}
          {rightAxis && <NumberFormatFields label={t("Right axis")} value={style.right_format} onChange={(right_format) => set({ ...style, right_format })} />}
        </Section>
      )}
    </Stack>
  );
}
