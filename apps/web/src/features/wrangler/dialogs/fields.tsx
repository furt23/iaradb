"use client";

import Checkbox from "@mui/material/Checkbox";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import OutlinedInput from "@mui/material/OutlinedInput";
import Select from "@mui/material/Select";
import type { ColumnInfo } from "@iara/protocol";

import { isNumericType, typeLabel } from "@/lib/format";

/** The aggregations that read numbers: their column is picked among the numeric ones. */
export const needsNumber = (fn: string) => fn === "sum" || fn === "avg" || fn === "median";

export const pickable = (columns: ColumnInfo[], fn: string) => (needsNumber(fn) ? columns.filter((c) => isNumericType(c.type)) : columns);

export const has = (columns: ColumnInfo[], name: string) => columns.some((c) => c.name === name);

/** One column; `none` adds an empty choice with that label. */
export function ColumnSelect({
  label,
  columns,
  value,
  onChange,
  none,
}: {
  label: string;
  columns: ColumnInfo[];
  value: string;
  onChange: (name: string) => void;
  none?: string;
}) {
  return (
    <FormControl fullWidth size="small">
      <InputLabel shrink={none ? true : undefined}>{label}</InputLabel>
      <Select
        value={has(columns, value) ? value : ""}
        label={label}
        displayEmpty={!!none}
        notched={none ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        {none && <MenuItem value="">{none}</MenuItem>}
        {columns.map((c) => (
          <MenuItem key={c.name} value={c.name}>
            {c.name} ({typeLabel(c.type)})
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

/** Several columns, in the order they were picked. */
export function ColumnsSelect({
  label,
  columns,
  value,
  onChange,
}: {
  label: string;
  columns: ColumnInfo[];
  value: string[];
  onChange: (names: string[]) => void;
}) {
  return (
    <FormControl fullWidth size="small">
      <InputLabel>{label}</InputLabel>
      <Select
        multiple
        value={value}
        onChange={(e) => onChange(typeof e.target.value === "string" ? e.target.value.split(",") : e.target.value)}
        input={<OutlinedInput label={label} />}
        renderValue={(selected) => selected.join(", ")}
      >
        {columns.map((c) => (
          <MenuItem key={c.name} value={c.name}>
            <Checkbox size="small" checked={value.includes(c.name)} />
            <ListItemText primary={c.name} secondary={typeLabel(c.type)} />
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}
