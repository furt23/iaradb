"use client";

import CloseOutlined from "@mui/icons-material/CloseOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { ColumnInfo } from "@iara/protocol";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChartControls } from "@/features/results/chart/ChartControls";
import { fitSpec } from "@/features/results/chart/chartSpec";
import { usesRows } from "@/lib/dashboards/chartFields";
import type { Dataset, TableWidget, Widget, WidgetData } from "@/lib/dashboards/types";

import { ChartStyleSettings } from "./ChartStyleSettings";
import { lookIdOf, withLook } from "./chartLooks";
import { ColumnFormatSettings } from "./ColumnFormatSettings";
import { CALENDAR_COLUMN_INFO, isCalendar } from "./calendarColumns";
import { withCurrent } from "./datasets";
import { FieldWells } from "./FieldWells";
import { FilterSettings } from "./FilterSettings";
import { PANEL_FIELDS, PANEL_HEADING } from "./panelStyle";
import { widgetLabel } from "./newWidget";
import { columnsIn, useReadColumns, type FoundColumns } from "./useDatasetColumns";
import { useModel } from "./useModel";
import { VisualGallery } from "./VisualGallery";

/** The datasets whose columns a widget's settings list. */
function usedDatasets(widget: Widget): string[] {
  if (widget.kind === "chart" || widget.kind === "table") return [widget.dataset];
  return widget.kind === "filter" ? [...new Set((widget.fields ?? []).map((f) => f.dataset))] : [];
}

/** The settings of the selected widget; every edit goes to `onChange` (`reload`: the data changes with it, true unless said otherwise). */
export function WidgetPanel({
  widget,
  data,
  datasets,
  found,
  load,
  onChange,
  onMeasure,
  onClose,
}: {
  /** a measure on the chart was clicked: it is edited where measures are */
  onMeasure?(name: string): void;
  widget: Widget;
  /** what it draws now: the series and categories its colors are set for */
  data: WidgetData | undefined;
  datasets: Dataset[];
  found: FoundColumns;
  load(name: string): Promise<ColumnInfo[]>;
  onChange(widget: Widget, reload?: boolean): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const model = useModel();
  const [tab, setTab] = useState<"data" | "format">("data");
  const word = (key: string, vars: { column: string }) => t(key, vars);
  const used = usedDatasets(widget).filter((name) => !isCalendar(model.calendars, name));
  const key = used.join(",");
  // the columns are read again each time the panel opens or the datasets are
  useEffect(() => {
    for (const name of key ? key.split(",") : []) load(name).catch(() => undefined);
  }, [key, load]);
  // charts and tables can take a field of any dataset, so all their columns are listed
  useReadColumns(datasets, found, load, widget.kind === "chart" || widget.kind === "table");

  const datasetSelect = (value: string, set: (name: string) => void) => (
    <TextField select size="small" fullWidth label={t("Dataset")} value={value} onChange={(e) => set(e.target.value)}>
      {withCurrent(datasets.map((d) => d.name), value).map((n) => (
        <MenuItem key={n} value={n}>
          {n}
        </MenuItem>
      ))}
    </TextField>
  );

  /** What a table can show: its dataset's columns as they are, and the others' as `dataset.column`. */
  const tableColumns = (table: TableWidget): string[] => {
    const own = columnsIn(found, table.dataset).map((c) => c.name);
    const others = datasets.filter((d) => d.name !== table.dataset).flatMap((d) => columnsIn(found, d.name).map((c) => `${d.name}.${c.name}`));
    const calendars = model.calendars.flatMap((c) => CALENDAR_COLUMN_INFO.map((x) => `${c.name}.${x.name}`));
    return [...(table.columns ?? []).filter((c) => !own.includes(c) && !others.includes(c) && !calendars.includes(c)), ...own, ...others, ...calendars];
  };

  return (
    <Box component="aside" aria-label={t("Widget settings")} sx={{ width: 340, flexShrink: 0, overflow: "auto", borderLeft: 1, borderColor: "divider", bgcolor: "background.paper", ...PANEL_FIELDS }}>
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
            <Tabs value={tab} onChange={(_, next: "data" | "format") => setTab(next)} variant="fullWidth" aria-label={t("Widget settings")} sx={{ minHeight: 36, "& .MuiTab-root": { minHeight: 36, py: 0 } }}>
              <Tab value="data" label={t("Data")} />
              <Tab value="format" label={t("Format")} />
            </Tabs>
            {tab === "data" && (
              <>
                <VisualGallery value={lookIdOf(widget)} onPick={(def) => onChange(withLook(widget, def, columnsIn(found, widget.dataset), word))} />
                {usesRows(widget) ? (
                  <>
                    {datasetSelect(widget.dataset, (dataset) => {
                      onChange({ ...widget, dataset });
                      // keep the columns the new dataset has
                      load(dataset).then((columns) => onChange({ ...widget, dataset, spec: fitSpec(widget.spec, columns) }), () => undefined);
                    })}
                    <Box sx={{ mx: -2 }}>
                      <ChartControls spec={widget.spec} columns={columnsIn(found, widget.dataset)} hideKinds onChange={(spec) => onChange({ ...widget, spec })} />
                    </Box>
                  </>
                ) : (
                  <FieldWells widget={widget} datasets={datasets} found={found} onChange={(w) => onChange(w)} onMeasure={onMeasure} />
                )}
              </>
            )}
            {tab === "format" && <ChartStyleSettings widget={widget} data={data} onChange={(w) => onChange(w, false)} />}
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
              {tableColumns(widget).map((n) => (
                <MenuItem key={n} value={n}>
                  {n}
                </MenuItem>
              ))}
            </TextField>
            <Stack spacing={1}>
              <Typography sx={PANEL_HEADING}>{t("Format")}</Typography>
              <ColumnFormatSettings widget={widget} columns={tableFormatColumns(widget, datasets, found)} onChange={(w) => onChange(w, false)} />
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

/** The columns a table's formats can name: its dataset's, and the related ones it shows, under the names it shows them by. */
function tableFormatColumns(table: TableWidget, datasets: Dataset[], found: FoundColumns): ColumnInfo[] {
  const others = datasets
    .filter((d) => d.name !== table.dataset)
    .flatMap((d) => columnsIn(found, d.name).map((c) => ({ ...c, name: `${d.name}.${c.name}` })))
    .filter((c) => table.columns?.includes(c.name));
  return [...columnsIn(found, table.dataset), ...others];
}
