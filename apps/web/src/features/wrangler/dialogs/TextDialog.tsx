"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { ColumnInfo } from "@iara/protocol";
import { useEffect, useState } from "react";

import type { TextCaseMode, WranglerStep } from "../types";
import { typeLabel } from "@/lib/format";

interface Props {
  open: boolean;
  columns: ColumnInfo[];
  defaultColumn?: string;
  onClose: () => void;
  onApply: (step: WranglerStep) => void;
}

export function TextDialog({ open, columns, defaultColumn, onClose, onApply }: Props) {
  const [tab, setTab] = useState<"trim" | "case" | "replace" | "split">("trim");
  const [column, setColumn] = useState<string>(
    defaultColumn || columns.find((c) => c.type.toLowerCase().includes("string") || c.type.toLowerCase().includes("utf8"))?.name || columns[0]?.name || ""
  );
  const [caseMode, setCaseMode] = useState<TextCaseMode>("upper");
  const [pattern, setPattern] = useState<string>("");
  const [replacement, setReplacement] = useState<string>("");
  const [isRegex, setIsRegex] = useState<boolean>(false);
  const [delimiter, setDelimiter] = useState<string>(" ");
  const [parts, setParts] = useState<number>(2);

  useEffect(() => {
    if (open) {
      setColumn(
        defaultColumn || columns.find((c) => c.type.toLowerCase().includes("string") || c.type.toLowerCase().includes("utf8"))?.name || columns[0]?.name || ""
      );
    }
  }, [open, defaultColumn, columns]);

  const handleApply = () => {
    if (!column) return;

    if (tab === "trim") {
      onApply({
        id: `trim_${Date.now()}`,
        label: `Trim whitespace in ${column}`,
        enabled: true,
        op: { kind: "text_trim", column },
      });
    } else if (tab === "case") {
      onApply({
        id: `case_${Date.now()}`,
        label: `Convert ${column} to ${caseMode}case`,
        enabled: true,
        op: { kind: "text_case", column, mode: caseMode },
      });
    } else if (tab === "replace") {
      onApply({
        id: `replace_${Date.now()}`,
        label: `Replace '${pattern}' with '${replacement}' in ${column}`,
        enabled: true,
        op: { kind: "text_replace", column, pattern, replacement, isRegex },
      });
    } else if (tab === "split") {
      onApply({
        id: `split_${Date.now()}`,
        label: `Split ${column} by '${delimiter}' into ${parts} columns`,
        enabled: true,
        op: { kind: "split_column", column, delimiter, numParts: parts },
      });
    }
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Text</DialogTitle>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ px: 2, borderBottom: 1, borderColor: "divider" }}>
        <Tab value="trim" label="Trim" />
        <Tab value="case" label="Case" />
        <Tab value="replace" label="Replace" />
        <Tab value="split" label="Split" />
      </Tabs>

      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 2 }}>
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

        {tab === "trim" && (
          <Box sx={{ color: "text.secondary", fontSize: 13 }}>
            Removes leading and trailing spaces, tabs, and newline characters from values in <strong>{column}</strong>.
          </Box>
        )}

        {tab === "case" && (
          <FormControl fullWidth size="small">
            <InputLabel>Case</InputLabel>
            <Select value={caseMode} label="Case" onChange={(e) => setCaseMode(e.target.value as TextCaseMode)}>
              <MenuItem value="upper">UPPERCASE (all caps)</MenuItem>
              <MenuItem value="lower">lowercase (all small)</MenuItem>
              <MenuItem value="title">Title case (capitalize each word)</MenuItem>
            </Select>
          </FormControl>
        )}

        {tab === "replace" && (
          <>
            <TextField
              label="Find"
              size="small"
              fullWidth
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="Inc."
            />
            <TextField
              label="Replacement"
              size="small"
              fullWidth
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              placeholder="Incorporated"
            />
            <FormControlLabel
              control={<Checkbox size="small" checked={isRegex} onChange={(e) => setIsRegex(e.target.checked)} />}
              label={<Typography variant="body2">Use regular expression</Typography>}
            />
          </>
        )}

        {tab === "split" && (
          <>
            <TextField
              label="Delimiter"
              size="small"
              fullWidth
              value={delimiter}
              onChange={(e) => setDelimiter(e.target.value)}
              placeholder=","
            />
            <TextField
              label="Number of output columns"
              type="number"
              size="small"
              fullWidth
              value={parts}
              onChange={(e) => setParts(Math.max(2, parseInt(e.target.value, 10) || 2))}
              slotProps={{ htmlInput: { min: 2, max: 10 } }}
            />
          </>
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
