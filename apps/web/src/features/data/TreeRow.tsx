"use client";

import MoreHoriz from "@mui/icons-material/MoreHoriz";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import type { MouseEvent, ReactNode } from "react";

/** Where a catalog menu opens: at a point (right click) or at a button. */
export type MenuAnchor = HTMLElement | { x: number; y: number };

/** A row of the catalog tree: its content, and a "…" button that shows on hover. */
export function TreeRow({
  active,
  indent,
  menuLabel,
  onMenu,
  children,
}: {
  active: boolean;
  /** spacing units from the left edge */
  indent: number;
  menuLabel: string;
  onMenu(e: MouseEvent<HTMLElement>, anchor: MenuAnchor): void;
  children: ReactNode;
}) {
  return (
    <Box
      onContextMenu={(e) => onMenu(e, { x: e.clientX, y: e.clientY })}
      sx={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        ml: indent,
        borderRadius: 1,
        bgcolor: active ? "action.selected" : "transparent",
        "&:hover": { bgcolor: active ? "action.selected" : "action.hover" },
        "&:hover .row-menu, &:focus-within .row-menu": { opacity: 1 },
        ...(active ? { "& .row-menu": { opacity: 1 } } : {}),
        "@media (hover: none)": { "& .row-menu": { opacity: 1 } },
      }}
    >
      {children}
      <IconButton
        className="row-menu"
        aria-label={menuLabel}
        onClick={(e) => onMenu(e, e.currentTarget)}
        sx={{ position: "absolute", right: 2, p: 0.25, opacity: 0, transition: "opacity 100ms" }}
      >
        <MoreHoriz sx={{ fontSize: 16 }} />
      </IconButton>
    </Box>
  );
}
