"use client";

import Add from "@mui/icons-material/Add";
import AutoFixHighOutlined from "@mui/icons-material/AutoFixHighOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { ColumnInfo } from "@iara/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { CodeEditor } from "@/features/editor/CodeEditor";
import type { Dataset } from "@/lib/dashboards/types";
import type { Schema } from "@/lib/model/types";

import { appendLines, checkAdded } from "./measureLine";
import { QuickMeasureDialog } from "./QuickMeasureDialog";
import type { FoundColumns } from "./useDatasetColumns";
import { modelSchema, useModel, useModelSource } from "./useModel";
import { useModelComplete } from "./useModelComplete";

const MESSAGE_DELAY_MS = 600;

/** One line of the model, `name = expression`, typed below the measures select. */
function FormulaLine({ schema, onAdd, onCancel }: { schema: Schema; onAdd(lines: string[], name: string): Promise<void>; onCancel(): void }) {
  const { t } = useTranslation();
  const model = useModel();
  const { source } = useModelSource();
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);
  const checked = useMemo(() => checkAdded(source, line, schema), [source, line, schema]);
  const lint = useCallback(async (code: string) => checkAdded(source, code, schema).diagnostics, [source, schema]);
  const complete = useModelComplete(model, schema);
  // memoised: the editor rebuilds its extensions when it gets a new assist object
  const assist = useMemo(() => ({ lint, complete }), [lint, complete]);

  const add = async (text: string, name: string) => {
    setBusy(true);
    try {
      await onAdd([text], name);
    } finally {
      setBusy(false);
    }
  };

  /** The editor holds one line: Enter adds the measure when it checks, and a pasted break is a space. */
  const change = (value: string) => {
    if (!/[\r\n]/.test(value)) return setLine(value);
    const flat = value.replace(/\s*[\r\n]+\s*/g, " ");
    setLine(flat);
    const text = flat.trim();
    const result = checkAdded(source, text, schema);
    if (result.ok && !busy) void add(text, result.measure!);
  };

  // the message waits for a pause in the typing: a formula half written is not an error to shout about
  const [settled, setSettled] = useState(line);
  useEffect(() => {
    const id = setTimeout(() => setSettled(line), MESSAGE_DELAY_MS);
    return () => clearTimeout(id);
  }, [line]);
  const message = settled === line && line.trim() ? checked.diagnostics.find((d) => d.severity === "error")?.message : undefined;
  return (
    // the editor closes its list of completions on Escape (and says so by preventing the default): the next one cancels
    <Stack spacing={1} onKeyDown={(e) => e.key === "Escape" && !e.defaultPrevented && onCancel()}>
      <Paper variant="outlined" sx={{ overflow: "hidden" }}>
        <CodeEditor value={line} onChange={change} language="python" assist={assist} lineNumbers={false} autoFocus placeholder={t("name = expression")} />
      </Paper>
      {message && (
        <Typography role="alert" sx={{ fontSize: 12, color: "error.main", overflowWrap: "anywhere" }}>
          {message}
        </Typography>
      )}
      <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1 }}>
        <Button size="small" onClick={onCancel}>
          {t("Cancel")}
        </Button>
        <Button size="small" variant="contained" disabled={!checked.ok || busy} onClick={() => void add(line.trim(), checked.measure!)}>
          {t("Add")}
        </Button>
      </Box>
    </Stack>
  );
}

/**
 * Under a chart's measures: a line to write a new measure in, or a dialog that writes it from a template.
 * Either way the lines go into the model's source and `onAdded` gets the name of the measure.
 */
export function NewMeasure({
  datasets,
  found,
  load,
  onAdded,
}: {
  datasets: Dataset[];
  found: FoundColumns;
  load(name: string): Promise<ColumnInfo[]>;
  onAdded(name: string): void;
}) {
  const { t } = useTranslation();
  const { source, setSource } = useModelSource();
  const schema = useMemo(() => modelSchema(datasets, found), [datasets, found]);
  const [formula, setFormula] = useState(false);
  const [quick, setQuick] = useState(false);

  /** Saves the source with the lines before the chart is told, or the chart would draw a measure the saved model lacks. */
  const add = async (lines: string[], name: string) => {
    await setSource(appendLines(source, lines), true);
    setFormula(false);
    setQuick(false);
    onAdded(name);
  };

  return (
    <Stack spacing={1}>
      <Box sx={{ display: "flex", gap: 1 }}>
        <Button size="small" startIcon={<Add />} disabled={formula} onClick={() => setFormula(true)}>
          {t("New measure")}
        </Button>
        <Button size="small" startIcon={<AutoFixHighOutlined />} onClick={() => setQuick(true)}>
          {t("Quick measure")}
        </Button>
      </Box>
      {formula && <FormulaLine schema={schema} onAdd={add} onCancel={() => setFormula(false)} />}
      <QuickMeasureDialog open={quick} datasets={datasets} found={found} load={load} schema={schema} onAdd={add} onClose={() => setQuick(false)} />
    </Stack>
  );
}
