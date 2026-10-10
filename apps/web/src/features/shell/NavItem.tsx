"use client";

import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";

export interface NavItemProps {
  icon: ReactNode;
  /** the text beside the icon, shown when the rail is expanded */
  label: string;
  /** the accessible name, when it is not the label */
  name?: string;
  /** the tooltip when the rail is collapsed (the label by default) */
  tooltip?: string;
  /** a muted shortcut at the right, shown when expanded */
  hint?: string;
  expanded: boolean;
  active?: boolean;
  href?: string;
  onClick(e: MouseEvent<HTMLElement>): void;
}

/** One row of the navigation rail: an icon, and its label when the rail is expanded. */
export function NavItem({ icon, label, name = label, tooltip = label, hint, expanded, active = false, href, onClick }: NavItemProps) {
  const content = (
    <>
      {icon}
      {expanded && (
        <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0, fontWeight: 500 }}>
          {label}
        </Typography>
      )}
      {expanded && hint && (
        <Box component="kbd" sx={{ ml: "auto", px: 0.75, borderRadius: 1, border: 1, borderColor: "divider", fontSize: 11, lineHeight: 1.6, color: "text.secondary" }}>
          {hint}
        </Box>
      )}
    </>
  );
  const sx = {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 1.5,
    width: "100%",
    height: 36,
    px: 1,
    minWidth: 0,
    borderRadius: 2,
    color: active ? "secondary.main" : "text.secondary",
    bgcolor: active ? "action.selected" : "transparent",
    "&:hover": { bgcolor: active ? "action.selected" : "action.hover" },
  };
  const row = href ? (
    <ButtonBase component={Link} href={href} aria-label={name} aria-current={active ? "page" : undefined} onClick={onClick} sx={sx}>
      {content}
    </ButtonBase>
  ) : (
    <ButtonBase aria-label={name} onClick={onClick} sx={sx}>
      {content}
    </ButtonBase>
  );
  // the tooltip only matters while the labels are hidden
  return (
    <Tooltip title={tooltip} placement="right" disableHoverListener={expanded} disableFocusListener={expanded} disableTouchListener={expanded}>
      {row}
    </Tooltip>
  );
}
