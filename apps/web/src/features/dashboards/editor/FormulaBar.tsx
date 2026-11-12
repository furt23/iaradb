"use client";

import CheckOutlined from "@mui/icons-material/CheckOutlined";
import CloseOutlined from "@mui/icons-material/CloseOutlined";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import { EditorView } from "@codemirror/view";
import type { ColumnInfo } from "@iara/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { CodeEditor } from "@/features/editor/CodeEditor";
import type { Dataset, NumberFormat } from "@/lib/dashboards/types";

import { checkNew, checkReplaced, NO_CHECK, takenNames, type DraftCheck } from "./measureDraft";
import { MeasureFormatControl } from "./MeasureFormatControl";
import { measureText, replaceMeasure, withFormat } from "./modelEdits";
import { useReadColumns, type FoundColumns } from "./useDatasetColumns";
import type { FormulaTarget } from "./useFormulaBar";
import type { MeasureActions } from "./useMeasureActions";
import { modelSchema, useModel, useModelSource } from "./useModel";
import { useModelComplete } from "./useModelComplete";

const MESSAGE_DELAY_MS = 600;
const FORMAT_SAVE_MS = 500;

/** One line: a break is a space (shortcut: a `#` comment inside a measure written over several lines would swallow what follows it). */
const flatten = (value: string) => value.replace(/\s*[\r\n]+\s*/g, " ");

/**
 * Where a measure is written on the canvas: a line, `name = expression`, for a new measure or one being edited,
 * with its number format beside it. Enter or the check mark saves it, Escape or the cross drops it.
 */
export function FormulaBar({
  target,
  datasets,
  found,
  load,
  actions,
  onClose,
}: {
  target: FormulaTarget;
  datasets: Dataset[];
  found: FoundColumns;
  load(name: string): Promise<ColumnInfo[]>;
  actions: MeasureActions;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const model = useModel();
  const { source } = useModelSource();
  const schema = useMemo(() => modelSchema(datasets, found), [datasets, found]);
  const edit = target.mode === "edit" ? target : null;
  const editName = edit?.name;
  const start = editName === undefined ? undefined : model.measures.find((m) => m.name === editName)?.span.from;
  const original = useMemo(() => (editName === undefined ? "" : measureText(source, editName)), [source, editName]);
  // the measure is gone (deleted elsewhere): nothing to edit
  const gone = editName !== undefined && (original === null || start === undefined);

  const [line, setLine] = useState(() => flatten(original ?? ""));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);

  // the columns the completions and the check know
  useReadColumns(datasets, found, load);

  // the editor is made after this renders: the cursor goes to the end of an edited line, or the name is selected for a rename
  useEffect(() => {
    if (!editName) return;
    const id = requestAnimationFrame(() => {
      const dom = box.current?.querySelector<HTMLElement>(".cm-editor");
      const view = dom && EditorView.findFromDOM(dom);
      if (!view) return;
      const named = edit?.select === "name" && view.state.doc.toString().startsWith(editName);
      view.dispatch({ selection: named ? { anchor: 0, head: editName.length } : { anchor: view.state.doc.length } });
      view.focus();
    });
    return () => cancelAnimationFrame(id);
    // once, when the bar opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const taken = useMemo(() => takenNames(model, editName), [model, editName]);
  const check = useCallback(
    (text: string): DraftCheck => {
      if (editName === undefined) return checkNew(source, text, schema);
      if (start === undefined) return NO_CHECK;
      try {
        return checkReplaced(replaceMeasure(source, editName, text), start, text, schema);
      } catch {
        return NO_CHECK;
      }
    },
    [editName, source, schema, start],
  );
  const lint = useCallback(async (code: string) => check(code).diagnostics, [check]);
  const complete = useModelComplete(model, schema);
  // memoised: the editor rebuilds its extensions when it gets a new assist object
  const assist = useMemo(() => ({ lint, complete }), [lint, complete]);

  const checked = useMemo(() => check(line.trim()), [check, line]);
  const clash = checked.name !== undefined && taken.includes(checked.name);
  const valid = (c: DraftCheck) => c.ok && !(c.name !== undefined && taken.includes(c.name));

  const commit = async (text: string, name: string) => {
    setBusy(true);
    setFailure(undefined);
    try {
      if (edit) await actions.save(edit.name, text);
      else await actions.add([text], name);
      onClose();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** The editor holds one line: Enter saves the measure when it checks, and a pasted break is a space. */
  const change = (value: string) => {
    setFailure(undefined);
    if (!/[\r\n]/.test(value)) return setLine(value);
    const flat = flatten(value);
    setLine(flat);
    const text = flat.trim();
    const result = check(text);
    if (valid(result) && !busy) void commit(text, result.name!);
  };

  // a format picked for a measure that exists applies at once, as a chart's does; the bar stays open. A pause first: decimals are typed digit by digit
  const formatSave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(formatSave.current), []);
  const setFormat = (format: NumberFormat | null) => {
    let next: string;
    try {
      next = withFormat(line.trim(), format);
    } catch {
      // not one `name = expression` line (the control is off then)
      return;
    }
    setLine(next);
    clearTimeout(formatSave.current);
    const result = check(next);
    // a new name waits for the check mark: saving it would rename what the bar is editing
    if (!edit || !valid(result) || result.name !== edit.name) return;
    formatSave.current = setTimeout(() => {
      setFailure(undefined);
      actions.save(edit.name, next).catch((e: Error) => setFailure(e.message));
    }, FORMAT_SAVE_MS);
  };

  // the message waits for a pause in the typing: a formula half written is not an error to shout about
  const [settled, setSettled] = useState(line);
  useEffect(() => {
    const id = setTimeout(() => setSettled(line), MESSAGE_DELAY_MS);
    return () => clearTimeout(id);
  }, [line]);
  const problem = clash ? t("{{name}} is already defined", { name: checked.name }) : checked.diagnostics.find((d) => d.severity === "error")?.message;
  const message = failure ?? (settled === line && line.trim() ? problem : undefined);

  if (gone) return null;
  const canSave = valid(checked) && !busy;
  return (
    // the editor closes its list of completions on Escape (and says so by preventing the default): the next one cancels
    <Box
      role="group"
      aria-label={t("Formula bar")}
      onKeyDown={(e) => e.key === "Escape" && !e.defaultPrevented && onClose()}
      sx={{ px: 2, py: 1, borderBottom: 1, borderColor: "divider", flexShrink: 0 }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flex: "1 1 360px", minWidth: 0 }}>
          <IconButton size="small" aria-label={t("Cancel")} onClick={onClose}>
            <CloseOutlined fontSize="small" />
          </IconButton>
          <IconButton size="small" color="primary" aria-label={edit ? t("Save") : t("Add")} disabled={!canSave} onClick={() => void commit(line.trim(), checked.name ?? "")}>
            <CheckOutlined fontSize="small" />
          </IconButton>
          <Typography aria-hidden sx={{ fontFamily: "var(--font-mono, monospace)", fontSize: 13, color: "text.secondary", px: 0.5 }}>
            ƒx
          </Typography>
          <Paper ref={box} variant="outlined" sx={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
            <CodeEditor value={line} onChange={change} language="python" assist={assist} lineNumbers={false} autoFocus placeholder={t("name = expression")} />
          </Paper>
        </Box>
        <MeasureFormatControl format={checked.format} disabled={!checked.ok || busy} onChange={setFormat} />
      </Box>
      {message && (
        <Typography role="alert" sx={{ fontSize: 12, color: "error.main", mt: 0.5, overflowWrap: "anywhere" }}>
          {message}
        </Typography>
      )}
    </Box>
  );
}
