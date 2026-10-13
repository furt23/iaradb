"use client";

import ListItemIcon from "@mui/material/ListItemIcon";
import MenuItem from "@mui/material/MenuItem";
import Tooltip from "@mui/material/Tooltip";
import type { ReactNode } from "react";

/** An entry of a catalog menu: an icon and a label. */
export function ActionItem({ icon, label, onClick, danger, disabled, hint }: { icon: ReactNode; label: string; onClick(): void; danger?: boolean; disabled?: boolean; hint?: string }) {
  const item = (
    <MenuItem onClick={onClick} disabled={disabled} sx={danger ? { color: "error.main" } : undefined}>
      <ListItemIcon sx={danger ? { color: "error.main" } : undefined}>{icon}</ListItemIcon>
      {label}
    </MenuItem>
  );
  // a disabled item takes no pointer events: the tooltip sits on a wrapper
  return hint ? (
    <Tooltip title={hint} placement="right">
      <span>{item}</span>
    </Tooltip>
  ) : (
    item
  );
}
