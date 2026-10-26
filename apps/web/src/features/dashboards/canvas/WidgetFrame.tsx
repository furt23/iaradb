"use client";

import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";

/**
 * The card around a widget: a header with its title (the grid drags by the
 * `dash-drag` part of it) and the widget's own actions, then the body. A
 * widget without a title has a header only as a thin strip to drag it by.
 */
export function WidgetFrame({
  title,
  selected,
  draggable,
  onClick,
  actions,
  children,
}: {
  title?: string;
  selected?: boolean;
  draggable?: boolean;
  onClick?(): void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const header = title || actions || draggable;
  return (
    <Paper
      variant="outlined"
      component="section"
      aria-label={title}
      onClick={onClick}
      sx={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden", outline: selected ? 2 : 0, outlineColor: "primary.main", outlineOffset: -1 }}
    >
      {header && (
        <Box sx={{ display: "flex", alignItems: "center", flexShrink: 0, minHeight: title ? 32 : 18, pl: 1.5, pr: 0.5 }}>
          <Box className="dash-drag" sx={{ flex: 1, minWidth: 0, alignSelf: "stretch", display: "flex", alignItems: "center", cursor: draggable ? "move" : "default" }}>
            {title && (
              <Typography variant="h4" noWrap sx={{ fontSize: 13 }}>
                {title}
              </Typography>
            )}
          </Box>
          {actions}
        </Box>
      )}
      <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>{children}</Box>
    </Paper>
  );
}
