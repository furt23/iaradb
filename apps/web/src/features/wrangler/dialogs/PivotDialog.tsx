"use client";

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

import type { PivotAgg, WranglerStep } from "../types";
import { isNumericType } from "@/lib/format";
import { ColumnSelect, ColumnsSelect, has, pickable } from "./fields";

type Mode = "pivot" | "unpivot";

interface Props {
  open: boolean;
  columns: ColumnInfo[];
  defaultColumn?: string;
  /** the tab shown when the dialog opens */
  initialTab?: Mode;
  onClose: () => void;
  onApply: (step: WranglerStep) => void;
}

export function PivotDialog({ open, columns, defaultColumn, initialTab = "pivot", onClose, onApply }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Mode>(initialTab);
  const [index, setIndex] = useState<string[]>([]);
  const [column, setColumn] = useState("");
  const [value, setValue] = useState("");
  const [agg, setAgg] = useState<PivotAgg>("sum");
  const [wide, setWide] = useState<string[]>([]);
  const [nameCol, setNameCol] = useState("attribute");
  const [valueCol, setValueCol] = useState("value");

  const AGGS: { agg: PivotAgg; label: string }[] = [
    { agg: "sum", label: t("Sum") },
    { agg: "count", label: t("Count") },
    { agg: "avg", label: t("Average") },
    { agg: "min", label: t("Min") },
    { agg: "max", label: t("Max") },
  ];

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setIndex([]);
      setColumn(defaultColumn || columns[0]?.name || "");
      setValue(columns.find((c) => isNumericType(c.type) && c.name !== defaultColumn)?.name ?? "");
      setAgg("sum");
      setWide(defaultColumn ? [defaultColumn] : []);
      setNameCol("attribute");
      setValueCol("value");
    }
  }, [open, initialTab, defaultColumn, columns]);

  const columnOptions = columns.filter((c) => !index.includes(c.name));
  const valueOptions = pickable(columns, agg);
  const pivotOk = index.length > 0 && has(columnOptions, column) && has(valueOptions, value);

  // the new columns must not clash with the ones that stay
  const kept = columns.filter((c) => !wide.includes(c.name));
  const nameN = nameCol.trim();
  const valueN = valueCol.trim();
  const unpivotOk = wide.length > 0 && !!nameN && !!valueN && nameN !== valueN && !has(kept, nameN) && !has(kept, valueN);

  const handleApply = () => {
    if (tab === "pivot") {
      if (!pivotOk) return;
      onApply({
        id: `pivot_${Date.now()}`,
        label: t("Pivot {{column}}: {{agg}} of {{value}} by {{index}}", {
          column,
          agg: (AGGS.find((a) => a.agg === agg)?.label ?? agg).toLowerCase(),
          value,
          index: index.join(", "),
        }),
        enabled: true,
        op: { kind: "pivot", index, column, value, agg },
      });
    } else {
      if (!unpivotOk) return;
      onApply({
        id: `unpivot_${Date.now()}`,
        label: t("Unpivot {{columns}} into {{name}}, {{value}}", { columns: wide.join(", "), name: nameN, value: valueN }),
        enabled: true,
        op: { kind: "unpivot", columns: wide, name: nameN, value: valueN },
      });
    }
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{t("Reshape")}</DialogTitle>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ px: 2, borderBottom: 1, borderColor: "divider" }}>
        <Tab value="pivot" label={t("Pivot")} />
        <Tab value="unpivot" label={t("Unpivot")} />
      </Tabs>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 2 }}>
        {tab === "pivot" ? (
          <>
            <ColumnsSelect label={t("Rows (one per distinct value)")} columns={columns} value={index} onChange={setIndex} />
            <ColumnSelect label={t("Column whose values become columns")} columns={columnOptions} value={column} onChange={setColumn} />
            <FormControl fullWidth size="small">
              <InputLabel>{t("Aggregation")}</InputLabel>
              <Select value={agg} label={t("Aggregation")} onChange={(e) => setAgg(e.target.value as PivotAgg)}>
                {AGGS.map((a) => (
                  <MenuItem key={a.agg} value={a.agg}>
                    {a.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <ColumnSelect label={t("Value column")} columns={valueOptions} value={value} onChange={setValue} />
          </>
        ) : (
          <>
            <ColumnsSelect label={t("Columns to turn into rows")} columns={columns} value={wide} onChange={setWide} />
            <TextField
              label={t("Name of the column holding the old column names")}
              size="small"
              fullWidth
              value={nameCol}
              error={!nameN || nameN === valueN || has(kept, nameN)}
              onChange={(e) => setNameCol(e.target.value)}
            />
            <TextField
              label={t("Name of the column holding the values")}
              size="small"
              fullWidth
              value={valueCol}
              error={!valueN || nameN === valueN || has(kept, valueN)}
              onChange={(e) => setValueCol(e.target.value)}
            />
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("Cancel")}</Button>
        <Button variant="contained" onClick={handleApply} disabled={tab === "pivot" ? !pivotOk : !unpivotOk}>
          {t("Apply")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
