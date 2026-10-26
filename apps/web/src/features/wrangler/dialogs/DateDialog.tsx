"use client";

import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import type { ColumnInfo } from "@iara/protocol";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { DatePart, DateUnit, WranglerStep } from "../types";
import { typeLabel } from "@/lib/format";
import { ColumnSelect, has } from "./fields";

interface Props {
  open: boolean;
  columns: ColumnInfo[];
  defaultColumn?: string;
  onClose: () => void;
  onApply: (step: WranglerStep) => void;
}

const isDate = (c: ColumnInfo) => /^(date|timestamp)/.test(typeLabel(c.type));

export function DateDialog({ open, columns, defaultColumn, onClose, onApply }: Props) {
  const { t } = useTranslation();
  const dates = columns.filter(isDate);
  const [tab, setTab] = useState<"part" | "trunc">("part");
  const [column, setColumn] = useState("");
  const [part, setPart] = useState<DatePart>("month");
  const [unit, setUnit] = useState<DateUnit>("month");
  // null while the name is the default one (it follows the column and the choice)
  const [name, setName] = useState<string | null>(null);

  const WORDS: Record<DatePart, string> = {
    year: t("Year"),
    quarter: t("Quarter"),
    month: t("Month"),
    week: t("Week"),
    day: t("Day"),
    weekday: t("Weekday"),
  };
  const PARTS: { part: DatePart; label: string }[] = [
    { part: "year", label: WORDS.year },
    { part: "quarter", label: WORDS.quarter },
    { part: "month", label: t("Month (1-12)") },
    { part: "week", label: t("Week (ISO)") },
    { part: "day", label: t("Day of month") },
    { part: "weekday", label: t("Weekday (0 = Sunday)") },
  ];
  const UNITS = (["year", "quarter", "month", "week", "day"] as const).map((unit) => ({ unit, label: WORDS[unit] }));

  useEffect(() => {
    if (open) {
      setColumn((defaultColumn && has(columns.filter(isDate), defaultColumn) ? defaultColumn : columns.find(isDate)?.name) ?? "");
      setName(null);
    }
  }, [open, defaultColumn, columns]);

  const shown = (name ?? (tab === "part" ? `${column}_${part}` : `${column}_${unit}_start`)).trim();
  const clash = has(columns, shown);
  const valid = !!column && !!shown && !clash;

  const handleApply = () => {
    if (!valid) return;
    onApply(
      tab === "part"
        ? {
            id: `date_part_${Date.now()}`,
            label: t("Extract {{part}} of {{column}} as {{name}}", { part: WORDS[part].toLowerCase(), column, name: shown }),
            enabled: true,
            op: { kind: "date_part", column, part, as: shown },
          }
        : {
            id: `date_trunc_${Date.now()}`,
            label: t("Start of {{unit}} of {{column}} as {{name}}", { unit: WORDS[unit].toLowerCase(), column, name: shown }),
            enabled: true,
            op: { kind: "date_trunc", column, unit, as: shown },
          },
    );
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{t("Date part")}</DialogTitle>
      <Tabs
        value={tab}
        onChange={(_, v) => {
          setTab(v);
          setName(null);
        }}
        sx={{ px: 2, borderBottom: 1, borderColor: "divider" }}
      >
        <Tab value="part" label={t("Extract a part")} />
        <Tab value="trunc" label={t("Start of period")} />
      </Tabs>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 2 }}>
        {dates.length === 0 ? (
          <Alert severity="info">{t("No date or timestamp column here: change a column's type first (Columns, Change type).")}</Alert>
        ) : (
          <>
            <ColumnSelect label={t("Date column")} columns={dates} value={column} onChange={setColumn} />

            {tab === "part" ? (
              <FormControl fullWidth size="small">
                <InputLabel>{t("Part")}</InputLabel>
                <Select value={part} label={t("Part")} onChange={(e) => setPart(e.target.value as DatePart)}>
                  {PARTS.map((p) => (
                    <MenuItem key={p.part} value={p.part}>
                      {p.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            ) : (
              <FormControl fullWidth size="small">
                <InputLabel>{t("Period")}</InputLabel>
                <Select value={unit} label={t("Period")} onChange={(e) => setUnit(e.target.value as DateUnit)}>
                  {UNITS.map((u) => (
                    <MenuItem key={u.unit} value={u.unit}>
                      {u.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}

            <TextField
              label={t("New column name")}
              size="small"
              fullWidth
              value={name ?? shown}
              error={!shown || clash}
              helperText={clash ? t("A column with this name already exists.") : undefined}
              onChange={(e) => setName(e.target.value)}
            />
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
