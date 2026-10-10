"use client";

import Search from "@mui/icons-material/Search";
import InputAdornment from "@mui/material/InputAdornment";
import ListSubheader from "@mui/material/ListSubheader";
import TextField from "@mui/material/TextField";
import type { KeyboardEvent } from "react";

/** Filters the clusters by name. Typed keys stay in the field: the menu must not take them for list navigation. */
export function ClusterSearch({ value, onChange }: { value: string; onChange(value: string): void }) {
  const keepTyping = (e: KeyboardEvent) => {
    if (e.key.length === 1 || e.key === "Home" || e.key === "End") e.stopPropagation();
  };
  return (
    <ListSubheader component="div" role="presentation" disableSticky onKeyDown={keepTyping} sx={{ lineHeight: "normal", px: 1.5, py: 1, bgcolor: "transparent", fontWeight: 400 }}>
      <TextField
        autoFocus
        fullWidth
        size="small"
        placeholder="Search clusters"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        slotProps={{
          htmlInput: { "aria-label": "search clusters" },
          input: { startAdornment: <InputAdornment position="start"><Search fontSize="small" /></InputAdornment> },
        }}
      />
    </ListSubheader>
  );
}
