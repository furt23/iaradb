"use client";

import Add from "@mui/icons-material/Add";
import Close from "@mui/icons-material/Close";
import Alert from "@mui/material/Alert";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormHelperText from "@mui/material/FormHelperText";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { ColumnInfo } from "@iara/protocol";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { JoinHow, WranglerStep } from "../types";
import { tableNames } from "@/features/dashboards/editor/datasets";
import { catalogSchema } from "@/server/actions/catalog";
import { ColumnSelect, has } from "./fields";

interface Props {
  open: boolean;
  columns: ColumnInfo[];
  defaultColumn?: string;
  onClose: () => void;
  onApply: (step: WranglerStep) => void;
}

type Pair = { left: string; right: string };

export function JoinDialog({ open, columns, defaultColumn, onClose, onApply }: Props) {
  const { t } = useTranslation();
  const [schema, setSchema] = useState<Record<string, ColumnInfo[]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [table, setTable] = useState<string | null>(null);
  const [how, setHow] = useState<JoinHow>("left");
  const [on, setOn] = useState<Pair[]>([]);
  // the table's columns left out; everything else is brought
  const [skipped, setSkipped] = useState<string[]>([]);

  // the catalog is read each time the dialog opens: tables may have been added since
  useEffect(() => {
    if (!open) return;
    let live = true;
    setSchema(null);
    setError(null);
    setTable(null);
    setHow("left");
    setOn([]);
    setSkipped([]);
    void catalogSchema().then((r) => {
      if (!live) return;
      if (r.ok) setSchema(r.data);
      else setError(r.error.message);
    });
    return () => {
      live = false;
    };
  }, [open]);

  const tables = useMemo(() => (schema ? tableNames(schema) : []), [schema]);
  const right = (table && schema?.[table]) || [];

  const pick = (name: string | null) => {
    const cols = (name && schema?.[name]) || [];
    // a column both sides share is the likely key
    const shared = columns.find((c) => has(cols, c.name))?.name;
    setTable(name);
    setSkipped([]);
    setOn(name ? [{ left: shared ?? defaultColumn ?? columns[0]?.name ?? "", right: shared ?? cols[0]?.name ?? "" }] : []);
  };

  const editPair = (i: number, patch: Partial<Pair>) => setOn((p) => p.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  // a key of the table is already in the result as the current side's
  const brought = right.filter((c) => !on.some((p) => p.right === c.name) && !skipped.includes(c.name)).map((c) => c.name);
  const valid = !!table && on.length > 0 && on.every((p) => p.left && p.right) && brought.length > 0;

  const handleApply = () => {
    if (!table || !valid) return;
    const keys = on.map((p) => `${p.left} = ${p.right}`).join(", ");
    onApply({
      id: `join_${Date.now()}`,
      label: how === "left" ? t("Left join {{table}} on {{on}}", { table, on: keys }) : t("Inner join {{table}} on {{on}}", { table, on: keys }),
      enabled: true,
      op: { kind: "join", table, how, on, columns: brought },
    });
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t("Join a table")}</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 1 }}>
        {error && <Alert severity="error">{error}</Alert>}

        <Autocomplete
          size="small"
          options={tables}
          value={table}
          loading={!schema && !error}
          onChange={(_, v) => pick(v)}
          renderInput={(params) => <TextField {...params} label={t("Table")} />}
        />

        <FormControl fullWidth size="small">
          <InputLabel>{t("Keep")}</InputLabel>
          <Select value={how} label={t("Keep")} onChange={(e) => setHow(e.target.value as JoinHow)}>
            <MenuItem value="left">{t("Left join")}</MenuItem>
            <MenuItem value="inner">{t("Inner join")}</MenuItem>
          </Select>
          <FormHelperText>
            {how === "left"
              ? t("Keeps every row; the table's columns stay empty where nothing matches.")
              : t("Keeps only the rows that have a match in the table.")}
          </FormHelperText>
        </FormControl>

        {table && (
          <>
            <Typography variant="subtitle2">{t("Match on")}</Typography>
            {on.map((p, i) => (
              <Box key={i} sx={{ display: "flex", gap: 1, alignItems: "center" }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <ColumnSelect label={t("This data")} columns={columns} value={p.left} onChange={(left) => editPair(i, { left })} />
                </Box>
                <Typography sx={{ color: "text.secondary" }}>=</Typography>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <ColumnSelect label={table} columns={right} value={p.right} onChange={(r) => editPair(i, { right: r })} />
                </Box>
                <IconButton size="small" aria-label={t("Remove")} disabled={on.length === 1} onClick={() => setOn((o) => o.filter((_, j) => j !== i))}>
                  <Close fontSize="small" />
                </IconButton>
              </Box>
            ))}
            <Button
              size="small"
              startIcon={<Add fontSize="small" />}
              onClick={() => setOn((o) => [...o, { left: columns[0]?.name ?? "", right: right[0]?.name ?? "" }])}
              sx={{ alignSelf: "flex-start" }}
            >
              {t("Add key")}
            </Button>

            <Typography variant="subtitle2">{t("Columns to bring")}</Typography>
            <Box sx={{ maxHeight: 180, overflow: "auto", display: "flex", flexDirection: "column", border: 1, borderColor: "divider", borderRadius: 1, px: 1 }}>
              {right
                .filter((c) => !on.some((p) => p.right === c.name))
                .map((c) => (
                  <FormControlLabel
                    key={c.name}
                    label={c.name}
                    control={
                      <Checkbox
                        size="small"
                        checked={!skipped.includes(c.name)}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setSkipped((s) => (checked ? s.filter((x) => x !== c.name) : [...s, c.name]));
                        }}
                      />
                    }
                  />
                ))}
            </Box>
          </>
        )}
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
