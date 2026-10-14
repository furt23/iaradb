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
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import type { ColumnInfo } from "@workhouse/protocol";
import { useState } from "react";

import type { FillNullStrategy, WranglerStep } from "../types";

interface Props {
  open: boolean;
  columns: ColumnInfo[];
  defaultColumn?: string;
  onClose: () => void;
  onApply: (step: WranglerStep) => void;
}

export function CleanDialog({ open, columns, defaultColumn, onClose, onApply }: Props) {
  const [tab, setTab] = useState<"fill" | "drop" | "dedup">("fill");
  const [column, setColumn] = useState<string>(defaultColumn || columns[0]?.name || "");
  const [fillStrategy, setFillStrategy] = useState<FillNullStrategy>("median");
  const [constantVal, setConstantVal] = useState<string>("0");
  const [dedupBy, setDedupBy] = useState<"row" | "column">("row");

  const handleApply = () => {
    if (tab === "fill") {
      const isConst = fillStrategy === "constant";
      const numVal = Number(constantVal);
      const val = isConst ? (!Number.isNaN(numVal) && constantVal.trim() !== "" ? numVal : constantVal) : undefined;
      onApply({
        id: `fill_${Date.now()}`,
        label: `Fill nulls in ${column} (${fillStrategy}${isConst ? `: ${constantVal}` : ""})`,
        enabled: true,
        op: { kind: "fill_null", column, strategy: fillStrategy, value: val },
      });
    } else if (tab === "drop") {
      onApply({
        id: `drop_nulls_${Date.now()}`,
        label: `Drop rows with null in ${column}`,
        enabled: true,
        op: { kind: "drop_nulls", columns: [column] },
      });
    } else if (tab === "dedup") {
      onApply({
        id: `dedup_${Date.now()}`,
        label: dedupBy === "row" ? "Remove duplicate rows" : `One row per ${column}`,
        enabled: true,
        op: { kind: "deduplicate", subset: dedupBy === "row" ? [] : [column] },
      });
    }
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Clean & Impute Data</DialogTitle>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ px: 2, borderBottom: 1, borderColor: "divider" }}>
        <Tab value="fill" label="Fill Nulls" />
        <Tab value="drop" label="Drop Nulls" />
        <Tab value="dedup" label="Deduplicate" />
      </Tabs>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 2 }}>
        {(tab !== "dedup" || dedupBy === "column") && (
          <FormControl fullWidth size="small">
            <InputLabel>Target Column</InputLabel>
            <Select value={column} label="Target Column" onChange={(e) => setColumn(e.target.value)}>
              {columns.map((c) => (
                <MenuItem key={c.name} value={c.name}>
                  {c.name} ({c.type})
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}

        {tab === "fill" && (
          <>
            <FormControl fullWidth size="small">
              <InputLabel>Imputation Strategy</InputLabel>
              <Select value={fillStrategy} label="Imputation Strategy" onChange={(e) => setFillStrategy(e.target.value as FillNullStrategy)}>
                <MenuItem value="median">Median (numeric)</MenuItem>
                <MenuItem value="mean">Mean / Average (numeric)</MenuItem>
                <MenuItem value="mode">Mode (most frequent value)</MenuItem>
                <MenuItem value="constant">Constant value</MenuItem>
              </Select>
            </FormControl>

            {fillStrategy === "constant" && (
              <TextField
                label="Replacement Value"
                size="small"
                fullWidth
                value={constantVal}
                onChange={(e) => setConstantVal(e.target.value)}
                placeholder="Enter constant value..."
              />
            )}
          </>
        )}

        {tab === "drop" && (
          <Box sx={{ color: "text.secondary", fontSize: 13 }}>
            Rows with a <code>null</code> or missing value in <strong>{column}</strong> will be removed from the dataset.
          </Box>
        )}

        {tab === "dedup" && (
          <FormControl fullWidth size="small">
            <InputLabel>Duplicates</InputLabel>
            <Select value={dedupBy} label="Duplicates" onChange={(e) => setDedupBy(e.target.value as "row" | "column")}>
              <MenuItem value="row">Rows equal in every column</MenuItem>
              <MenuItem value="column">Rows with the same {column} (any one is kept)</MenuItem>
            </Select>
          </FormControl>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handleApply}>
          Apply Clean Step
        </Button>
      </DialogActions>
    </Dialog>
  );
}
