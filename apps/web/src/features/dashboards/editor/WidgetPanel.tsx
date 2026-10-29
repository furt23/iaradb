"use client";

import CloseOutlined from "@mui/icons-material/CloseOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { ColumnInfo } from "@iara/protocol";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { ChartControls } from "@/features/results/chart/ChartControls";
import { fitSpec } from "@/features/results/chart/chartSpec";
import type { ChartWidget, Dataset, Widget } from "@/lib/dashboards/types";

import { ChartStyleSettings } from "./ChartStyleSettings";
import { ColumnFormatSettings } from "./ColumnFormatSettings";
import { withCurrent } from "./datasets";
import { FilterSettings } from "./FilterSettings";
import { widgetLabel } from "./newWidget";
import { columnsIn, type FoundColumns } from "./useDatasetColumns";
import { useModel } from "./useModel";

/** The datasets whose columns a widget's settings list. */
function usedDatasets(widget: Widget): string[] {
  if (widget.kind === "chart" || widget.kind === "table") return [widget.dataset];
  return widget.kind === "filter" ? [...new Set((widget.fields ?? []).map((f) => f.dataset))] : [];
}

/** The heading of the Format section of the settings. */
const SECTION_HEADING = { fontSize: 12, fontWeight: 650, color: "text.secondary" };

/** The settings of the selected widget; every edit goes to `onChange` (`reload`: the data changes with it, true unless said otherwise). */
export function WidgetPanel({
  widget,
  datasets,
  found,
  load,
  onChange,
  onClose,
}: {
  widget: Widget;
  datasets: Dataset[];
  found: FoundColumns;
  load(name: string): Promise<ColumnInfo[]>;
  onChange(widget: Widget, reload?: boolean): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const model = useModel();
  const used = usedDatasets(widget);
  const key = used.join(",");
  // the columns are read again each time the panel opens or the datasets are
  useEffect(() => {
    for (const name of key ? key.split(",") : []) load(name).catch(() => undefined);
  }, [key, load]);

  const datasetSelect = (value: string, set: (name: string) => void) => (
    <TextField select size="small" fullWidth label={t("Dataset")} value={value} onChange={(e) => set(e.target.value)}>
      {withCurrent(datasets.map((d) => d.name), value).map((n) => (
        <MenuItem key={n} value={n}>
          {n}
        </MenuItem>
      ))}
    </TextField>
  );

  /** The model's measures over the chart's dataset: a counter takes one, a chart several. */
  const measureSelect = (chart: ChartWidget) => {
    const names = model.measures.filter((m) => m.dataset === chart.dataset).map((m) => m.name);
    const picked = chart.measures ?? [];
    // a measure the model no longer has stays listed, so it can be seen and cleared
    const options = [...picked.filter((p) => !names.includes(p)), ...names];
    const set = (list: string[]) => onChange({ ...chart, measures: list.length ? list : undefined }, true);
    const helperText = names.length ? undefined : t("No measures for this dataset yet: write them in the Model tab");
    const items = options.map((n) => (
      <MenuItem key={n} value={n}>
        {n}
      </MenuItem>
    ));
    return chart.spec.kind === "counter" ? (
      <TextField select size="small" fullWidth label={t("Measures")} value={picked[0] ?? ""} helperText={helperText} onChange={(e) => set(e.target.value ? [e.target.value] : [])} slotProps={{ inputLabel: { shrink: true } }}>
        <MenuItem value="">
          <em>{t("Nothing")}</em>
        </MenuItem>
        {items}
      </TextField>
    ) : (
      <TextField
        select
        size="small"
        fullWidth
        label={t("Measures")}
        value={picked}
        helperText={helperText}
        onChange={(e) => {
          const v = e.target.value as string | string[];
          set(typeof v === "string" ? v.split(",") : v);
        }}
        slotProps={{
          inputLabel: { shrink: true },
          select: { multiple: true, displayEmpty: true, renderValue: (v) => ((v as string[]).length ? (v as string[]).join(", ") : t("Nothing")) },
        }}
      >
        {items}
      </TextField>
    );
  };

  return (
    <Box component="aside" aria-label={t("Widget settings")} sx={{ width: 340, flexShrink: 0, overflow: "auto", borderLeft: 1, borderColor: "divider", bgcolor: "background.paper" }}>
      <Box sx={{ display: "flex", alignItems: "center", px: 2, minHeight: 48, borderBottom: 1, borderColor: "divider" }}>
        <Typography sx={{ flex: 1, fontWeight: 650 }}>{t(widgetLabel(widget))}</Typography>
        <IconButton size="small" aria-label={t("Close settings")} onClick={onClose}>
          <CloseOutlined fontSize="small" />
        </IconButton>
      </Box>
      <Stack spacing={2} sx={{ p: 2 }}>
        {used.map((name) =>
          typeof found[name] === "string" ? (
            <Alert key={name} severity="warning">
              {t("Could not read the columns of {{name}}: {{error}}", { name, error: found[name] })}
            </Alert>
          ) : null,
        )}
        {widget.kind !== "text" && (
          <TextField size="small" fullWidth label={t("Title")} value={widget.title ?? ""} onChange={(e) => onChange({ ...widget, title: e.target.value || undefined }, false)} />
        )}
        {widget.kind === "chart" && (
          <>
            {datasetSelect(widget.dataset, (dataset) => {
              // the measures are of the dataset they were picked from
              onChange({ ...widget, dataset, measures: undefined });
              // keep the columns the new dataset has
              load(dataset).then((columns) => onChange({ ...widget, dataset, measures: undefined, spec: fitSpec(widget.spec, columns) }), () => undefined);
            })}
            {measureSelect(widget)}
            <Box sx={{ mx: -2 }}>
              <ChartControls spec={widget.spec} columns={columnsIn(found, widget.dataset)} hideValues={!!widget.measures?.length} onChange={(spec) => onChange({ ...widget, spec })} />
            </Box>
            <Stack spacing={1}>
              <Typography sx={SECTION_HEADING}>{t("Format")}</Typography>
              <ChartStyleSettings widget={widget} onChange={(w) => onChange(w, false)} />
            </Stack>
          </>
        )}
        {widget.kind === "table" && (
          <>
            {datasetSelect(widget.dataset, (dataset) => onChange({ ...widget, dataset, columns: undefined }))}
            <TextField
              select
              size="small"
              fullWidth
              label={t("Columns")}
              value={widget.columns ?? []}
              onChange={(e) => {
                const v = e.target.value as string | string[];
                const list = typeof v === "string" ? v.split(",") : v;
                onChange({ ...widget, columns: list.length ? list : undefined });
              }}
              slotProps={{
                inputLabel: { shrink: true },
                select: { multiple: true, displayEmpty: true, renderValue: (v) => ((v as string[]).length ? (v as string[]).join(", ") : t("All columns")) },
              }}
            >
              {withCurrentAll(columnsIn(found, widget.dataset), widget.columns).map((n) => (
                <MenuItem key={n} value={n}>
                  {n}
                </MenuItem>
              ))}
            </TextField>
            <Stack spacing={1}>
              <Typography sx={SECTION_HEADING}>{t("Format")}</Typography>
              <ColumnFormatSettings widget={widget} columns={columnsIn(found, widget.dataset)} onChange={(w) => onChange(w, false)} />
            </Stack>
          </>
        )}
        {widget.kind === "text" && (
          <TextField label={t("Markdown")} multiline minRows={8} fullWidth value={widget.markdown} onChange={(e) => onChange({ ...widget, markdown: e.target.value })} />
        )}
        {widget.kind === "filter" && <FilterSettings widget={widget} datasets={datasets} found={found} load={load} onChange={onChange} />}
      </Stack>
    </Box>
  );
}

/** The column names, with those already picked that the dataset no longer has. */
function withCurrentAll(columns: ColumnInfo[], picked: string[] = []): string[] {
  const names = columns.map((c) => c.name);
  return [...picked.filter((p) => !names.includes(p)), ...names];
}
