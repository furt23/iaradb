"use client";

import ListItemIcon from "@mui/material/ListItemIcon";
import MenuItem from "@mui/material/MenuItem";
import type { ReactNode } from "react";

/** An entry of a catalog menu: an icon and a label. */
export function ActionItem({ icon, label, onClick, danger, disabled }: { icon: ReactNode; label: string; onClick(): void; danger?: boolean; disabled?: boolean }) {
  return (
    <MenuItem onClick={onClick} disabled={disabled} sx={danger ? { color: "error.main" } : undefined}>
      <ListItemIcon sx={danger ? { color: "error.main" } : undefined}>{icon}</ListItemIcon>
      {label}
    </MenuItem>
  );
}
