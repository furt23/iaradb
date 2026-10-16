"use client";

import Add from "@mui/icons-material/Add";
import Close from "@mui/icons-material/Close";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface Row {
  key: string;
  value: string;
}

/** The record the rows stand for: keys trimmed, empty keys dropped, the first of a duplicated key wins. */
function toRecord(rows: Row[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of rows) {
    const k = key.trim();
    if (k && !(k in out)) out[k] = value;
  }
  return out;
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => k in b && b[k] === a[k]);
}

/** Editable rows of key and value pairs (the empty rows stay here until they have a key). */
export function KeyValueEditor({
  label,
  keyLabel,
  valueLabel,
  value,
  onChange,
  disabled,
  helperText,
}: {
  label: string;
  keyLabel: string;
  valueLabel: string;
  value: Record<string, string>;
  onChange(next: Record<string, string>): void;
  disabled?: boolean;
  helperText?: string;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[]>(() => Object.entries(value).map(([key, v]) => ({ key, value: v })));

  // follow the parent's value when it changes from outside (the rows we emit already match it)
  useEffect(() => {
    setRows((current) => (sameRecord(toRecord(current), value) ? current : Object.entries(value).map(([key, v]) => ({ key, value: v }))));
  }, [value]);

  const update = (next: Row[]) => {
    setRows(next);
    onChange(toRecord(next));
  };

  const keys = rows.map((r) => r.key.trim()).filter(Boolean);
  const duplicated = new Set(keys.filter((k, i) => keys.indexOf(k) !== i));

  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle2">{label}</Typography>
      {rows.map((row, i) => {
        const dup = duplicated.has(row.key.trim());
        return (
          <Box key={i}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <TextField
                size="small"
                label={keyLabel}
                value={row.key}
                disabled={disabled}
                error={dup}
                onChange={(e) => update(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                sx={{ flex: 1 }}
              />
              <TextField
                size="small"
                label={valueLabel}
                value={row.value}
                disabled={disabled}
                onChange={(e) => update(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                sx={{ flex: 2 }}
              />
              <IconButton aria-label={t("Remove")} disabled={disabled} onClick={() => update(rows.filter((_, j) => j !== i))}>
                <Close fontSize="small" />
              </IconButton>
            </Stack>
            {dup && (
              <Typography variant="caption" sx={{ display: "block", mt: 0.5, color: "error.main" }}>
                {t("Duplicate key")}
              </Typography>
            )}
          </Box>
        );
      })}
      <Button startIcon={<Add />} disabled={disabled} onClick={() => setRows([...rows, { key: "", value: "" }])} sx={{ alignSelf: "flex-start" }}>
        {t("Add")}
      </Button>
      {helperText && (
        <Typography variant="caption" sx={{ display: "block", color: "text.secondary" }}>
          {helperText}
        </Typography>
      )}
    </Stack>
  );
}
