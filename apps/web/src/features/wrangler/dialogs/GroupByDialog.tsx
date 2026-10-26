"use client";

import Add from "@mui/icons-material/Add";
import Close from "@mui/icons-material/Close";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { ColumnInfo } from "@iara/protocol";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AggFn, WranglerStep } from "../types";
import { isNumericType } from "@/lib/format";
import { ColumnSelect, ColumnsSelect, has, pickable } from "./fields";

interface Props {
  open: boolean;
  columns: ColumnInfo[];
  defaultColumn?: string;
  onClose: () => void;
  onApply: (step: WranglerStep) => void;
}

/** `as` is null while the name is the default one (it follows the function and column). */
interface Row {
  id: number;
  fn: AggFn;
  column: string;
  as: string | null;
}

const autoName = (fn: AggFn, column: string) => (column ? `${fn}_${column}` : fn);

export function GroupByDialog({ open, columns, defaultColumn, onClose, onApply }: Props) {
  const { t } = useTranslation();
  const seq = useRef(0);
  const [keys, setKeys] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);

  const FNS: { fn: AggFn; label: string }[] = [
    { fn: "count", label: t("Count") },
    { fn: "count_distinct", label: t("Count distinct") },
    { fn: "sum", label: t("Sum") },
    { fn: "avg", label: t("Average") },
    { fn: "min", label: t("Min") },
    { fn: "max", label: t("Max") },
    { fn: "median", label: t("Median") },
  ];

  useEffect(() => {
    if (open) {
      setKeys(defaultColumn ? [defaultColumn] : []);
      setRows([{ id: seq.current++, fn: "count", column: "", as: null }]);
    }
  }, [open, defaultColumn]);

  const edit = (id: number, patch: (r: Row) => Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch(r) } : r)));

  const addRow = () => {
    const num = columns.find((c) => isNumericType(c.type));
    setRows((rs) => [...rs, { id: seq.current++, fn: num ? "sum" : "count", column: num?.name ?? "", as: null }]);
  };

  const named = rows.map((r) => ({ ...r, as: (r.as ?? autoName(r.fn, r.column)).trim() }));
  const names = [...keys, ...named.map((r) => r.as)];
  const taken = (name: string) => names.filter((n) => n === name).length > 1;
  const bad = (r: (typeof named)[number]) => !r.as || taken(r.as) || (r.fn !== "count" && !r.column);
  const valid = (keys.length > 0 || rows.length > 0) && !named.some(bad);

  const handleApply = () => {
    if (!valid) return;
    const aggs = named.map((r) => ({ fn: r.fn, ...(r.column ? { column: r.column } : {}), as: r.as }));
    const k = keys.join(", ");
    const a = aggs.map((x) => `${x.fn}(${x.column ?? "*"})`).join(", ");
    onApply({
      id: `group_by_${Date.now()}`,
      label: !keys.length
        ? t("Aggregate all rows: {{aggs}}", { aggs: a })
        : a
          ? t("Group by {{keys}}: {{aggs}}", { keys: k, aggs: a })
          : t("Group by {{keys}}", { keys: k }),
      enabled: true,
      op: { kind: "group_by", keys, aggs },
    });
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t("Group by")}</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 1 }}>
        <Box>
          <ColumnsSelect label={t("Group by columns")} columns={columns} value={keys} onChange={setKeys} />
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {t("Leave empty to summarize all rows into one.")}
          </Typography>
        </Box>

        <Typography variant="subtitle2">{t("Aggregations")}</Typography>
        {rows.map((r, i) => (
          <Box key={r.id} sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}>
            <FormControl size="small" sx={{ width: 150, flexShrink: 0 }}>
              <InputLabel>{t("Function")}</InputLabel>
              <Select
                value={r.fn}
                label={t("Function")}
                onChange={(e) => {
                  const fn = e.target.value as AggFn;
                  edit(r.id, (old) => ({ fn, column: has(pickable(columns, fn), old.column) ? old.column : "" }));
                }}
              >
                {FNS.map((f) => (
                  <MenuItem key={f.fn} value={f.fn}>
                    {f.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <ColumnSelect
                label={t("Column")}
                columns={pickable(columns, r.fn)}
                value={r.column}
                none={r.fn === "count" ? t("All rows") : undefined}
                onChange={(column) => edit(r.id, () => ({ column }))}
              />
            </Box>
            <TextField
              label={t("Name")}
              size="small"
              sx={{ width: 160, flexShrink: 0 }}
              value={r.as ?? autoName(r.fn, r.column)}
              error={!named[i].as || taken(named[i].as)}
              helperText={named[i].as && taken(named[i].as) ? t("Already used") : undefined}
              onChange={(e) => {
                const as = e.target.value;
                edit(r.id, () => ({ as }));
              }}
            />
            <IconButton size="small" aria-label={t("Remove")} onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))} sx={{ mt: 0.5 }}>
              <Close fontSize="small" />
            </IconButton>
          </Box>
        ))}
        <Button size="small" startIcon={<Add fontSize="small" />} onClick={addRow} sx={{ alignSelf: "flex-start" }}>
          {t("Add aggregation")}
        </Button>
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
