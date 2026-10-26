"use client";

import Add from "@mui/icons-material/Add";
import CloseOutlined from "@mui/icons-material/CloseOutlined";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import type { ColumnInfo } from "@iara/protocol";
import { useTranslation } from "react-i18next";

import { useNotify } from "@/features/shell/notify";
import type { Dataset, FilterControl, FilterField, FilterWidget } from "@/lib/dashboards/types";

import { paramNames, withCurrent } from "./datasets";
import { filterOver, filterValueType } from "./newWidget";
import { columnsIn, type FoundColumns } from "./useDatasetColumns";

const CONTROLS: { value: FilterControl; label: string }[] = [
  { value: "select", label: "Dropdown" },
  { value: "multi", label: "Multiple" },
  { value: "date_range", label: "Date range" },
  { value: "text", label: "Contains text" },
];

/**
 * How a filter narrows the data: by columns of datasets (no SQL), or by a
 * `:parameter` the datasets' queries declare. Its control and value type follow.
 */
export function FilterSettings({
  widget,
  datasets,
  found,
  load,
  onChange,
}: {
  widget: FilterWidget;
  datasets: Dataset[];
  found: FoundColumns;
  load(name: string): Promise<ColumnInfo[]>;
  onChange(widget: FilterWidget): void;
}) {
  const { t } = useTranslation();
  const notify = useNotify();
  const params = paramNames(datasets);
  const byColumns = widget.param === undefined;
  const fields = widget.fields ?? [];

  const typeOf = (f: FilterField) => columnsIn(found, f.dataset).find((c) => c.name === f.column)?.type ?? "";
  /** The filter over other fields: values are typed by the first column, as the control allows. */
  const withFields = (next: FilterField[], control = widget.control, firstType = typeOf(next[0])): FilterWidget => ({
    ...widget,
    control,
    fields: next,
    value_type: filterValueType(control, firstType),
  });
  const fail = (e: unknown) => notify((e as Error).message, "error");

  const setMode = async (mode: "columns" | "param") => {
    const base = { id: widget.id, kind: "filter" as const, title: widget.title, control: "select" as const };
    if (mode === "param") return onChange({ ...base, param: params[0] });
    try {
      const over = datasets[0] && filterOver(datasets[0].name, await load(datasets[0].name));
      if (over) onChange({ ...base, ...over });
      else notify(t("The first dataset has no columns to filter by."), "error");
    } catch (e) {
      fail(e);
    }
  };

  const setFieldDataset = async (i: number, dataset: string) => {
    try {
      const columns = await load(dataset);
      const column = columns.find((c) => c.name === fields[i].column) ?? columns[0];
      if (!column) throw new Error(t("{{name}} has no columns.", { name: dataset }));
      onChange(withFields(fields.map((f, j) => (j === i ? { dataset, column: column.name } : f)), widget.control, i === 0 ? column.type : undefined));
    } catch (e) {
      fail(e);
    }
  };

  const addField = async () => {
    const last = fields[fields.length - 1];
    const dataset = datasets.find((d) => d.name !== last.dataset)?.name ?? last.dataset;
    try {
      const columns = await load(dataset);
      const column = columns.find((c) => c.name === fields[0].column) ?? columns[0];
      if (column) onChange(withFields([...fields, { dataset, column: column.name }]));
    } catch (e) {
      fail(e);
    }
  };

  return (
    <Stack spacing={2}>
      <div>
        <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mb: 0.5 }}>
          {t("Narrow by")}
        </Typography>
        <ToggleButtonGroup size="small" exclusive fullWidth value={byColumns ? "columns" : "param"} onChange={(_, mode: "columns" | "param" | null) => mode && void setMode(mode)} aria-label={t("Narrow by")}>
          <ToggleButton value="columns" disabled={!datasets.length}>
            {t("Columns")}
          </ToggleButton>
          <ToggleButton value="param" disabled={!params.length && byColumns}>
            {t("Parameter")}
          </ToggleButton>
        </ToggleButtonGroup>
      </div>
      {byColumns ? (
        <>
          <TextField select size="small" fullWidth label={t("Control")} value={widget.control} onChange={(e) => onChange(withFields(fields, e.target.value as FilterControl))}>
            {CONTROLS.map((c) => (
              <MenuItem key={c.value} value={c.value}>
                {t(c.label)}
              </MenuItem>
            ))}
          </TextField>
          {fields.map((f, i) => (
            <Paper key={i} variant="outlined" sx={{ p: 1.5, display: "flex", gap: 1 }}>
              <Stack spacing={1.5} sx={{ flex: 1, minWidth: 0 }}>
                <TextField select size="small" label={t("Dataset")} value={f.dataset} onChange={(e) => void setFieldDataset(i, e.target.value)}>
                  {withCurrent(datasets.map((d) => d.name), f.dataset).map((n) => (
                    <MenuItem key={n} value={n}>
                      {n}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  select
                  size="small"
                  label={t("Column")}
                  value={f.column}
                  onChange={(e) => onChange(withFields(fields.map((x, j) => (j === i ? { ...x, column: e.target.value } : x))))}
                >
                  {withCurrent(columnsIn(found, f.dataset).map((c) => c.name), f.column).map((n) => (
                    <MenuItem key={n} value={n}>
                      {n}
                    </MenuItem>
                  ))}
                </TextField>
              </Stack>
              <IconButton size="small" aria-label={t("Remove column")} disabled={fields.length < 2} onClick={() => onChange(withFields(fields.filter((_, j) => j !== i)))} sx={{ alignSelf: "flex-start" }}>
                <CloseOutlined fontSize="small" />
              </IconButton>
            </Paper>
          ))}
          <Button size="small" startIcon={<Add />} onClick={() => void addField()} sx={{ alignSelf: "flex-start" }}>
            {t("Add another column")}
          </Button>
        </>
      ) : (
        <TextField select size="small" fullWidth label={t("Parameter")} value={widget.param ?? ""} onChange={(e) => onChange({ ...widget, param: e.target.value })}>
          {withCurrent(params, widget.param).map((p) => (
            <MenuItem key={p} value={p}>
              :{p}
            </MenuItem>
          ))}
        </TextField>
      )}
    </Stack>
  );
}
