"use client";

import ChevronLeft from "@mui/icons-material/ChevronLeft";
import ChevronRight from "@mui/icons-material/ChevronRight";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";

/** Collapses the navigation rail to icons, or expands it back to the labels. */
export function RailToggle({ expanded, onToggle }: { expanded: boolean; onToggle(): void }) {
  const label = expanded ? "collapse sidebar" : "expand sidebar";
  return (
    <Tooltip title={label} placement="right" disableFocusListener>
      <IconButton aria-label={label} onClick={onToggle} sx={{ width: 40, height: 36, borderRadius: 2, color: "text.secondary" }}>
        {expanded ? <ChevronLeft fontSize="small" /> : <ChevronRight fontSize="small" />}
      </IconButton>
    </Tooltip>
  );
}
