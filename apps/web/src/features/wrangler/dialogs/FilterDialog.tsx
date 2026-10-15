"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import type { ColumnInfo } from "@workhouse/protocol";
import { useEffect, useState } from "react";

import type { FilterOperator, WranglerStep } from "../types";
import { typeLabel } from "@/lib/format";

interface Props {
  open: boolean;
  columns: ColumnInfo[];
  defaultColumn?: string;
  onClose: () => void;
  onApply: (step: WranglerStep) => void;
}

const OPERATORS: { op: FilterOperator; label: string; needsValue: boolean; needsValue2?: boolean }[] = [
  { op: "equals", label: "Equals (=)", needsValue: true },
  { op: "not_equals", label: "Does not equal (!=)", needsValue: true },
  { op: "greater_than", label: "Greater than (>)", needsValue: true },
  { op: "greater_equal", label: "Greater than or equal (>=)", needsValue: true },
  { op: "less_than", label: "Less than (<)", needsValue: true },
  { op: "less_equal", label: "Less than or equal (<=)", needsValue: true },
  { op: "between", label: "Between (inclusive)", needsValue: true, needsValue2: true },
  { op: "contains", label: "Contains text", needsValue: true },
  { op: "not_contains", label: "Does not contain text", needsValue: true },
  { op: "starts_with", label: "Starts with", needsValue: true },
  { op: "ends_with", label: "Ends with", needsValue: true },
  { op: "is_null", label: "Is null", needsValue: false },
  { op: "is_not_null", label: "Is not null", needsValue: false },
];

export function FilterDialog({ open, columns, defaultColumn, onClose, onApply }: Props) {
  const [column, setColumn] = useState<string>(defaultColumn || columns[0]?.name || "");
  const [operator, setOperator] = useState<FilterOperator>("equals");
  const [val1, setVal1] = useState<string>("");
  const [val2, setVal2] = useState<string>("");

  useEffect(() => {
    if (open) {
      setColumn(defaultColumn || columns[0]?.name || "");
    }
  }, [open, defaultColumn, columns]);

  const opConfig = OPERATORS.find((o) => o.op === operator) || OPERATORS[0];

  const handleApply = () => {
    if (!column) return;
    const numVal1 = Number(val1);
    const finalVal1 = opConfig.needsValue && !Number.isNaN(numVal1) && val1.trim() !== "" ? numVal1 : val1;
    const numVal2 = Number(val2);
    const finalVal2 = opConfig.needsValue2 && !Number.isNaN(numVal2) && val2.trim() !== "" ? numVal2 : val2;

    const label = `${column} ${opConfig.label}${opConfig.needsValue ? ` ${val1}` : ""}${opConfig.needsValue2 ? ` and ${val2}` : ""}`;

    onApply({
      id: `filter_${Date.now()}`,
      label,
      enabled: true,
      op: {
        kind: "filter",
        column,
        op: operator,
        value: opConfig.needsValue ? finalVal1 : undefined,
        value2: opConfig.needsValue2 ? finalVal2 : undefined,
      },
    });
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Filter rows</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 1 }}>
        <FormControl fullWidth size="small">
          <InputLabel>Column</InputLabel>
          <Select value={column} label="Column" onChange={(e) => setColumn(e.target.value)}>
            {columns.map((c) => (
              <MenuItem key={c.name} value={c.name}>
                {c.name} ({typeLabel(c.type)})
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControl fullWidth size="small">
          <InputLabel>Condition</InputLabel>
          <Select value={operator} label="Condition" onChange={(e) => setOperator(e.target.value as FilterOperator)}>
            {OPERATORS.map((o) => (
              <MenuItem key={o.op} value={o.op}>
                {o.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        {opConfig.needsValue && (
          <TextField
            label="Value"
            size="small"
            fullWidth
            value={val1}
            onChange={(e) => setVal1(e.target.value)}
            placeholder="42"
          />
        )}

        {opConfig.needsValue2 && (
          <TextField
            label="And"
            size="small"
            fullWidth
            value={val2}
            onChange={(e) => setVal2(e.target.value)}
            placeholder="100"
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handleApply}>
          Apply
        </Button>
      </DialogActions>
    </Dialog>
  );
}
