"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { ColumnInfo } from "@iara/protocol";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { isTemporalType } from "@/features/results/chart/chartSpec";
import type { Dataset } from "@/lib/dashboards/types";
import { isNumericType } from "@/lib/format";
import type { Schema } from "@/lib/model/types";

import { checkAdded } from "./measureLine";
import { QUICK_TEMPLATES, quickMeasure, suggestName, templateOf, type QuickInitial, type QuickKind } from "./quickMeasures";
import { columnsIn, type FoundColumns } from "./useDatasetColumns";
import { useModel, useModelSource } from "./useModel";

const MONO = { fontFamily: "var(--font-mono, monospace)", fontSize: 12, overflowWrap: "anywhere", whiteSpace: "pre-wrap" } as const;

/** The columns a dataset offers: those of the kind the template reads, or all of them when it has none of that kind. */
function offered(columns: ColumnInfo[], kind: "number" | "date" | "any"): string[] {
  const fit = kind === "any" ? columns : columns.filter((c) => (kind === "number" ? isNumericType(c.type) : isTemporalType(c.type)));
  return (fit.length ? fit : columns).map((c) => c.name);
}

/** The value of a select among `options`: the one picked, else the first (or `fallback`, when there is none). */
const among = (picked: string, options: string[], fallback = ""): string => (options.includes(picked) ? picked : (options[0] ?? fallback));

function Select({ label, value, options, onChange, helperText, empty }: { label: string; value: string; options: string[]; onChange(value: string): void; helperText?: string; empty?: string }) {
  return (
    <TextField select size="small" fullWidth label={label} value={value} helperText={helperText} onChange={(e) => onChange(e.target.value)} disabled={!options.length && empty === undefined}>
      {empty !== undefined && <MenuItem value="">{empty}</MenuItem>}
      {options.map((o) => (
        <MenuItem key={o} value={o}>
          {o}
        </MenuItem>
      ))}
    </TextField>
  );
}

function QuickMeasureForm({
  datasets,
  found,
  load,
  schema,
  initial,
  onAdd,
  onClose,
}: {
  datasets: Dataset[];
  found: FoundColumns;
  load(name: string): Promise<ColumnInfo[]>;
  schema: Schema;
  /** the template and fields it opens on (default: Sum, the first dataset) */
  initial?: QuickInitial;
  onAdd(lines: string[], name: string): Promise<void>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const model = useModel();
  const { source } = useModelSource();
  const [kind, setKind] = useState<QuickKind>(initial?.kind ?? "sum");
  const [dataset, setDataset] = useState(initial?.dataset ?? datasets[0]?.name ?? "");
  const [column, setColumn] = useState(initial?.column ?? "");
  const [measure, setMeasure] = useState(initial?.measure ?? "");
  const [size, setSize] = useState("3");
  const [dateDataset, setDateDataset] = useState(datasets[0]?.name ?? "");
  const [dateColumn, setDateColumn] = useState("");
  const [typed, setTyped] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // the columns of the datasets the fields read
  useEffect(() => {
    for (const name of new Set([dataset, dateDataset])) if (name) load(name).catch(() => undefined);
  }, [dataset, dateDataset, load]);

  const template = templateOf(kind);
  const names = datasets.map((d) => d.name);
  const measures = model.measures.map((m) => m.name);
  const columns = offered(columnsIn(found, dataset), kind === "sum" || kind === "avg" ? "number" : "any");
  const noCalendar = !!template.time && model.calendars.length === 0;
  const fields = {
    dataset: among(dataset, names),
    // a % of total can total over the whole dataset
    column: template.shape === "percent" ? (columns.includes(column) ? column : "") : among(column, columns),
    measure: among(measure, measures),
    n: Number(size),
    date: { dataset: among(dateDataset, names), column: among(dateColumn, offered(columnsIn(found, dateDataset), "date")) },
  };
  const taken = [...Object.keys(schema), ...measures, ...model.calendars.map((c) => c.name), ...model.params.map((p) => p.name)];
  const name = typed ?? suggestName(kind, fields, taken);
  const built = quickMeasure(kind, fields, name, model.calendars, taken);
  const added = built?.lines.join("\n");
  const checked = useMemo(() => (added === undefined ? null : checkAdded(source, added, schema)), [added, source, schema]);
  const problem = checked?.diagnostics.find((d) => d.severity === "error")?.message;

  const add = async () => {
    if (!built || !checked?.ok) return;
    setBusy(true);
    try {
      await onAdd(built.lines, name.trim());
    } finally {
      setBusy(false);
    }
  };

  const fieldsFor = {
    column: (
      <>
        <Select label={t("Dataset")} value={fields.dataset} options={names} onChange={setDataset} />
        <Select label={t("Column")} value={fields.column} options={columns} onChange={setColumn} />
      </>
    ),
    dataset: <Select label={t("Dataset")} value={fields.dataset} options={names} onChange={setDataset} />,
    percent: (
      <>
        <Select label={t("Measure")} value={fields.measure} options={measures} onChange={setMeasure} helperText={measures.length ? undefined : t("No measures yet: create one from the Fields pane")} />
        <Select label={t("Total over")} value={fields.dataset} options={names} onChange={setDataset} />
        <Select label={t("Column")} value={fields.column} options={columns} onChange={setColumn} empty={t("The whole dataset")} />
      </>
    ),
    measure: <Select label={t("Measure")} value={fields.measure} options={measures} onChange={setMeasure} helperText={measures.length ? undefined : t("No measures yet: create one from the Fields pane")} />,
    rolling: (
      <>
        <Select label={t("Measure")} value={fields.measure} options={measures} onChange={setMeasure} helperText={measures.length ? undefined : t("No measures yet: create one from the Fields pane")} />
        <TextField
          size="small"
          fullWidth
          type="number"
          label={t("Number of values")}
          value={size}
          onChange={(e) => setSize(e.target.value)}
          slotProps={{ htmlInput: { min: 1, step: 1 } }}
        />
      </>
    ),
  }[template.shape];

  return (
    <>
      <DialogTitle>{t("Quick measure")}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField
            select
            size="small"
            fullWidth
            label={t("Template")}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as QuickKind);
              setTyped(null);
            }}
          >
            {QUICK_TEMPLATES.map((q) => (
              <MenuItem key={q.kind} value={q.kind}>
                {t(q.label)}
              </MenuItem>
            ))}
          </TextField>
          {fieldsFor}
          {noCalendar && (
            <>
              <Alert severity="info">{t("Time templates need a calendar. Pick the date column to build one from; it is added to the model first.")}</Alert>
              <Select label={t("Dataset")} value={fields.date.dataset} options={names} onChange={setDateDataset} />
              <Select label={t("Date column")} value={fields.date.column} options={offered(columnsIn(found, fields.date.dataset), "date")} onChange={setDateColumn} />
            </>
          )}
          <TextField size="small" fullWidth label={t("Name")} value={name} onChange={(e) => setTyped(e.target.value)} />
          <Box>
            <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mb: 0.5 }}>
              {t("Line to add")}
            </Typography>
            <Box component="pre" aria-label={t("Line to add")} sx={{ ...MONO, m: 0, p: 1.5, minHeight: 40, borderRadius: 1, border: 1, borderColor: "divider", bgcolor: "action.hover" }}>
              {added}
            </Box>
            {problem && (
              <Typography role="alert" sx={{ fontSize: 12, color: "error.main", mt: 0.5, overflowWrap: "anywhere" }}>
                {problem}
              </Typography>
            )}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("Cancel")}</Button>
        <Button variant="contained" disabled={!checked?.ok || busy} onClick={() => void add()}>
          {t("Add")}
        </Button>
      </DialogActions>
    </>
  );
}

/** Writes a measure for you: pick a template, fill its fields, see the line, give it a name. */
export function QuickMeasureDialog({ open, onClose, ...form }: { open: boolean; onClose(): void } & Omit<Parameters<typeof QuickMeasureForm>[0], "onClose">) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <QuickMeasureForm {...form} onClose={onClose} />
    </Dialog>
  );
}
