"use client";

import Add from "@mui/icons-material/Add";
import Close from "@mui/icons-material/Close";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

import type { ParamRow } from "./jobForm";

/** Name and value rows of a params table. */
export function ParamRows({ rows, onChange, label, errors = [] }: { rows: ParamRow[]; onChange(rows: ParamRow[]): void; label: string; errors?: string[] }) {
  const set = (i: number, patch: Partial<ParamRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Stack spacing={1} role="group" aria-label={label}>
      {rows.map((r, i) => (
        <Stack key={i} direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <TextField size="small" label="Name" value={r.key} onChange={(e) => set(i, { key: e.target.value })} sx={{ flex: 1 }} slotProps={{ htmlInput: { "aria-label": `${label} name ${i + 1}` } }} />
          <TextField size="small" label="Value" value={r.value} onChange={(e) => set(i, { value: e.target.value })} sx={{ flex: 1.4 }} slotProps={{ htmlInput: { "aria-label": `${label} value ${i + 1}` } }} />
          <IconButton size="small" aria-label={`remove ${label} ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <Close fontSize="small" />
          </IconButton>
        </Stack>
      ))}
      {errors.map((e) => (
        <Typography key={e} role="alert" sx={{ fontSize: 12, color: "error.main" }}>
          {e}
        </Typography>
      ))}
      <Button size="small" startIcon={<Add />} onClick={() => onChange([...rows, { key: "", value: "" }])} sx={{ alignSelf: "flex-start" }}>
        Add {label.toLowerCase().replace(/s$/, "")}
      </Button>
    </Stack>
  );
}
