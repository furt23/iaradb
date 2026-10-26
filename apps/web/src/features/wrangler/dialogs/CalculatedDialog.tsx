"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { ColumnInfo } from "@iara/protocol";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { WranglerStep } from "../types";
import { typeLabel } from "@/lib/format";
import { has } from "./fields";

interface Props {
  open: boolean;
  columns: ColumnInfo[];
  defaultColumn?: string;
  onClose: () => void;
  onApply: (step: WranglerStep) => void;
}

const CASE_TAIL = " THEN  ELSE  END";

export function CalculatedDialog({ open, columns, defaultColumn, onClose, onApply }: Props) {
  const { t } = useTranslation();
  const field = useRef<HTMLTextAreaElement>(null);
  const [name, setName] = useState("");
  const [expr, setExpr] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
      setExpr(defaultColumn ? `"${defaultColumn.replaceAll('"', '""')}"` : "");
    }
  }, [open, defaultColumn]);

  /** Replaces the selection with `make(selection)` and puts the cursor `back` characters before its end. */
  const edit = (make: (selection: string) => string, back = 0) => {
    const el = field.current;
    const a = el?.selectionStart ?? expr.length;
    const b = el?.selectionEnd ?? expr.length;
    const text = make(expr.slice(a, b));
    const pos = a + text.length - back;
    setExpr(expr.slice(0, a) + text + expr.slice(b));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  const newName = name.trim();
  const clash = has(columns, newName);
  const valid = !!newName && !clash && !!expr.trim();

  const handleApply = () => {
    if (!valid) return;
    const expression = expr.trim();
    onApply({
      id: `calculated_${Date.now()}`,
      label: `${newName} = ${expression.replace(/\s+/g, " ")}`,
      enabled: true,
      op: { kind: "calculated", name: newName, expression },
    });
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t("Calculated column")}</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 1 }}>
        <TextField
          label={t("New column name")}
          size="small"
          fullWidth
          value={name}
          error={clash}
          helperText={clash ? t("A column with this name already exists.") : undefined}
          onChange={(e) => setName(e.target.value)}
          placeholder="total_price"
        />

        <TextField
          label={t("SQL expression")}
          size="small"
          fullWidth
          multiline
          minRows={3}
          maxRows={8}
          inputRef={field}
          value={expr}
          onChange={(e) => setExpr(e.target.value)}
          placeholder={'"price" * "quantity"'}
          slotProps={{ htmlInput: { spellCheck: false, style: { fontFamily: "'JetBrains Mono Variable', monospace", fontSize: 13 } } }}
        />

        <Box>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {t("Columns")}
          </Typography>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, maxHeight: 96, overflow: "auto", mt: 0.5 }}>
            {columns.map((c) => (
              <Chip
                key={c.name}
                size="small"
                variant="outlined"
                label={c.name}
                title={typeLabel(c.type)}
                onClick={() => edit(() => `"${c.name.replaceAll('"', '""')}"`)}
              />
            ))}
          </Box>
        </Box>

        <Box>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {t("Operators and functions")}
          </Typography>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 0.5 }}>
            <Chip size="small" label="+" onClick={() => edit(() => " + ")} />
            <Chip size="small" label="−" onClick={() => edit(() => " - ")} />
            <Chip size="small" label="×" onClick={() => edit(() => " * ")} />
            <Chip size="small" label="÷" onClick={() => edit(() => " / ")} />
            <Chip size="small" label="round()" onClick={() => edit((s) => `round(${s})`, 1)} />
            <Chip size="small" label="coalesce()" onClick={() => edit((s) => `coalesce(${s}, )`, 3)} />
            <Chip size="small" label="concat()" onClick={() => edit((s) => `concat(${s}, )`, 3)} />
            <Chip size="small" label="CASE WHEN … END" onClick={() => edit((s) => `CASE WHEN ${s}${CASE_TAIL}`, CASE_TAIL.length)} />
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("Cancel")}</Button>
        <Button variant="contained" onClick={handleApply} disabled={!valid}>
          {t("Apply")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
