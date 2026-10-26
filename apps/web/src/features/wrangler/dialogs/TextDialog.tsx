"use client";

import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { ColumnInfo } from "@iara/protocol";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";

import type { TextCaseMode, WranglerStep } from "../types";
import { typeLabel } from "@/lib/format";

interface Props {
  open: boolean;
  columns: ColumnInfo[];
  defaultColumn?: string;
  onClose: () => void;
  onApply: (step: WranglerStep) => void;
}

const CASE_LABEL: Record<TextCaseMode, string> = { upper: "uppercase", lower: "lowercase", title: "titlecase" };

export function TextDialog({ open, columns, defaultColumn, onClose, onApply }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"trim" | "case" | "replace" | "split">("trim");
  const [column, setColumn] = useState<string>(
    defaultColumn || columns.find((c) => c.type.toLowerCase().includes("string") || c.type.toLowerCase().includes("utf8"))?.name || columns[0]?.name || ""
  );
  const [caseMode, setCaseMode] = useState<TextCaseMode>("upper");
  const [pattern, setPattern] = useState<string>("");
  const [replacement, setReplacement] = useState<string>("");
  const [isRegex, setIsRegex] = useState<boolean>(false);
  const [delimiter, setDelimiter] = useState<string>(" ");
  const [parts, setParts] = useState<number>(2);

  useEffect(() => {
    if (open) {
      setColumn(
        defaultColumn || columns.find((c) => c.type.toLowerCase().includes("string") || c.type.toLowerCase().includes("utf8"))?.name || columns[0]?.name || ""
      );
    }
  }, [open, defaultColumn, columns]);

  const handleApply = () => {
    if (!column) return;

    if (tab === "trim") {
      onApply({
        id: `trim_${Date.now()}`,
        label: t("Trim whitespace in {{column}}", { column }),
        enabled: true,
        op: { kind: "text_trim", column },
      });
    } else if (tab === "case") {
      onApply({
        id: `case_${Date.now()}`,
        label: t("Convert {{column}} to {{mode}}", { column, mode: t(CASE_LABEL[caseMode]) }),
        enabled: true,
        op: { kind: "text_case", column, mode: caseMode },
      });
    } else if (tab === "replace") {
      onApply({
        id: `replace_${Date.now()}`,
        label: t("Replace '{{pattern}}' with '{{replacement}}' in {{column}}", { pattern, replacement, column }),
        enabled: true,
        op: { kind: "text_replace", column, pattern, replacement, isRegex },
      });
    } else if (tab === "split") {
      onApply({
        id: `split_${Date.now()}`,
        label: t("Split {{column}} by '{{delimiter}}' into {{parts}} columns", { column, delimiter, parts }),
        enabled: true,
        op: { kind: "split_column", column, delimiter, numParts: parts },
      });
    }
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{t("Text")}</DialogTitle>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ px: 2, borderBottom: 1, borderColor: "divider" }}>
        <Tab value="trim" label={t("Trim")} />
        <Tab value="case" label={t("Case")} />
        <Tab value="replace" label={t("Replace")} />
        <Tab value="split" label={t("Split")} />
      </Tabs>

      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 2 }}>
        <FormControl fullWidth size="small">
          <InputLabel>{t("Column")}</InputLabel>
          <Select value={column} label={t("Column")} onChange={(e) => setColumn(e.target.value)}>
            {columns.map((c) => (
              <MenuItem key={c.name} value={c.name}>
                {c.name} ({typeLabel(c.type)})
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        {tab === "case" && (
          <FormControl fullWidth size="small">
            <InputLabel>{t("Case")}</InputLabel>
            <Select value={caseMode} label={t("Case")} onChange={(e) => setCaseMode(e.target.value as TextCaseMode)}>
              <MenuItem value="upper">{t("UPPERCASE (all caps)")}</MenuItem>
              <MenuItem value="lower">{t("lowercase (all small)")}</MenuItem>
              <MenuItem value="title">{t("Title case (capitalize each word)")}</MenuItem>
            </Select>
          </FormControl>
        )}

        {tab === "replace" && (
          <>
            <TextField
              label={t("Find")}
              size="small"
              fullWidth
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="Inc."
            />
            <TextField
              label={t("Replacement")}
              size="small"
              fullWidth
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              placeholder="Incorporated"
            />
            <FormControlLabel
              control={<Checkbox size="small" checked={isRegex} onChange={(e) => setIsRegex(e.target.checked)} />}
              label={<Typography variant="body2">{t("Use regular expression")}</Typography>}
            />
          </>
        )}

        {tab === "split" && (
          <>
            <TextField
              label={t("Delimiter")}
              size="small"
              fullWidth
              value={delimiter}
              onChange={(e) => setDelimiter(e.target.value)}
              placeholder=","
            />
            <TextField
              label={t("Number of output columns")}
              type="number"
              size="small"
              fullWidth
              value={parts}
              onChange={(e) => setParts(Math.max(2, parseInt(e.target.value, 10) || 2))}
              slotProps={{ htmlInput: { min: 2, max: 10 } }}
            />
          </>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>{t("Cancel")}</Button>
        <Button variant="contained" onClick={handleApply}>
          {t("Apply")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
