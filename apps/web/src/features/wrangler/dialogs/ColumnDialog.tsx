"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import OutlinedInput from "@mui/material/OutlinedInput";
import Select from "@mui/material/Select";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { ColumnInfo } from "@workhouse/protocol";
import { useEffect, useState } from "react";

import type { CastTargetType, WranglerStep } from "../types";
import { typeLabel } from "@/lib/format";

interface Props {
  open: boolean;
  columns: ColumnInfo[];
  defaultColumn?: string;
  onClose: () => void;
  onApply: (step: WranglerStep) => void;
}

const DATA_TYPES: { type: CastTargetType; label: string }[] = [
  { type: "int64", label: "Integer" },
  { type: "float64", label: "Float" },
  { type: "utf8", label: "Text" },
  { type: "bool", label: "Boolean" },
  { type: "date", label: "Date" },
  { type: "timestamp", label: "Timestamp" },
];

export function ColumnDialog({ open, columns, defaultColumn, onClose, onApply }: Props) {
  const [tab, setTab] = useState<"rename" | "cast" | "drop" | "round" | "encode">("rename");
  const [column, setColumn] = useState<string>(defaultColumn || columns[0]?.name || "");
  const [newName, setNewName] = useState<string>(defaultColumn ? `${defaultColumn}_renamed` : "");
  const [targetType, setTargetType] = useState<CastTargetType>("int64");
  const [dropList, setDropList] = useState<string[]>(defaultColumn ? [defaultColumn] : []);
  const [roundDecimals, setRoundDecimals] = useState<number>(2);

  useEffect(() => {
    if (open) {
      const col = defaultColumn || columns[0]?.name || "";
      setColumn(col);
      setNewName(col ? `${col}_renamed` : "");
      setDropList(col ? [col] : []);
    }
  }, [open, defaultColumn, columns]);

  const handleApply = () => {
    if (tab === "rename") {
      if (!column || !newName.trim()) return;
      onApply({
        id: `rename_${Date.now()}`,
        label: `Rename ${column} to ${newName.trim()}`,
        enabled: true,
        op: { kind: "rename_column", from: column, to: newName.trim() },
      });
    } else if (tab === "cast") {
      if (!column) return;
      onApply({
        id: `cast_${Date.now()}`,
        label: `Cast ${column} to ${targetType}`,
        enabled: true,
        op: { kind: "cast", column, toType: targetType },
      });
    } else if (tab === "drop") {
      if (dropList.length === 0) return;
      onApply({
        id: `drop_${Date.now()}`,
        label: `Drop column${dropList.length > 1 ? "s" : ""} ${dropList.join(", ")}`,
        enabled: true,
        op: { kind: "drop_columns", columns: dropList },
      });
    } else if (tab === "round") {
      if (!column) return;
      onApply({
        id: `round_${Date.now()}`,
        label: `Round ${column} to ${roundDecimals} decimal${roundDecimals !== 1 ? "s" : ""}`,
        enabled: true,
        op: { kind: "math_round", column, decimals: roundDecimals },
      });
    } else if (tab === "encode") {
      if (!column) return;
      onApply({
        id: `encode_${Date.now()}`,
        label: `One-hot encode ${column}`,
        enabled: true,
        op: { kind: "one_hot_encode", column },
      });
    }
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Columns</DialogTitle>
      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ px: 2, borderBottom: 1, borderColor: "divider" }}
      >
        <Tab value="rename" label="Rename" />
        <Tab value="cast" label="Change type" />
        <Tab value="drop" label="Drop" />
        <Tab value="round" label="Round" />
        <Tab value="encode" label="One-hot" />
      </Tabs>

      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 2 }}>
        {tab !== "drop" && (
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
        )}

        {tab === "rename" && (
          <TextField
            label="New name"
            size="small"
            fullWidth
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="customer_name"
          />
        )}

        {tab === "cast" && (
          <FormControl fullWidth size="small">
            <InputLabel>Type</InputLabel>
            <Select value={targetType} label="Type" onChange={(e) => setTargetType(e.target.value as CastTargetType)}>
              {DATA_TYPES.map((d) => (
                <MenuItem key={d.type} value={d.type}>
                  {d.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}

        {tab === "drop" && (
          <FormControl fullWidth size="small">
            <InputLabel>Columns to Drop</InputLabel>
            <Select
              multiple
              value={dropList}
              onChange={(e) => setDropList(typeof e.target.value === "string" ? e.target.value.split(",") : e.target.value)}
              input={<OutlinedInput label="Columns to drop" />}
              renderValue={(selected) => selected.join(", ")}
            >
              {columns.map((c) => (
                <MenuItem key={c.name} value={c.name}>
                  <Checkbox size="small" checked={dropList.indexOf(c.name) > -1} />
                  <ListItemText primary={c.name} secondary={typeLabel(c.type)} />
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}

        {tab === "round" && (
          <TextField
            label="Decimal places"
            type="number"
            size="small"
            fullWidth
            value={roundDecimals}
            onChange={(e) => setRoundDecimals(Math.max(0, parseInt(e.target.value, 10) || 0))}
            slotProps={{ htmlInput: { min: 0, max: 10 } }}
          />
        )}

        {tab === "encode" && (
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            Generates binary 0/1 indicator columns for the top distinct categories of <strong>{column}</strong>.
          </Typography>
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
