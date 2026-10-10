"use client";

import CloseRounded from "@mui/icons-material/CloseRounded";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { MouseEvent, ReactNode } from "react";

export interface TabChipProps {
  label: string;
  /** tooltip (the full path or name) */
  title: string;
  icon: (active: boolean) => ReactNode;
  active: boolean;
  /** e.g. unsaved changes */
  marker?: boolean;
  onSelect(): void;
  onClose(): void;
  onMenu?(e: MouseEvent): void;
}

/** One tab of a tab strip: click to show, middle-click or × to close, right-click for more. */
export function TabChip({ label, title, icon, active, marker, onSelect, onClose, onMenu }: TabChipProps) {
  return (
    <Tooltip title={title} enterDelay={600}>
      <Box
        role="tab"
        aria-selected={active}
        aria-label={label}
        onClick={onSelect}
        onAuxClick={(e) => e.button === 1 && onClose()}
        onContextMenu={
          onMenu
            ? (e) => {
                e.preventDefault();
                onMenu(e);
              }
            : undefined
        }
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.75,
          pl: 1.25,
          pr: 0.5,
          height: "100%",
          maxWidth: 220,
          flexShrink: 0,
          cursor: "pointer",
          borderRight: 1,
          borderColor: "divider",
          color: active ? "text.primary" : "text.secondary",
          bgcolor: active ? "background.default" : "transparent",
          boxShadow: active ? (t) => `inset 0 -2px 0 ${t.palette.secondary.main}` : "none",
          "&:hover": { bgcolor: active ? "background.default" : "action.hover" },
          "&:hover .tab-close, & .tab-close.on": { opacity: 1 },
        }}
      >
        {icon(active)}
        <Typography noWrap sx={{ fontSize: 13, fontWeight: active ? 650 : 450 }}>
          {label}
        </Typography>
        {marker && <Box aria-label="unsaved changes" sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: "secondary.main", flexShrink: 0 }} />}
        <IconButton
          className={`tab-close${active ? " on" : ""}`}
          aria-label={`close ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          sx={{ p: 0.25, opacity: 0, transition: "opacity 100ms" }}
        >
          <CloseRounded sx={{ fontSize: 14 }} />
        </IconButton>
      </Box>
    </Tooltip>
  );
}

/** A horizontal strip of tabs (the wheel scrolls it sideways) with actions on the right. */
export function TabBar({ label, children, actions, highlight }: { label: string; children: ReactNode; actions?: ReactNode; highlight?: boolean }) {
  return (
    <Box
      role="tablist"
      aria-label={label}
      sx={{
        display: "flex",
        alignItems: "stretch",
        height: 36,
        flexShrink: 0,
        borderBottom: 1,
        borderColor: "divider",
        bgcolor: "background.paper",
        boxShadow: highlight ? (t) => `inset 0 2px 0 ${t.palette.secondary.main}` : "none",
      }}
    >
      <Box
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
        }}
        sx={{ display: "flex", flex: 1, minWidth: 0, overflowX: "auto", scrollbarWidth: "none", "&::-webkit-scrollbar": { display: "none" } }}
      >
        {children}
      </Box>
      {actions}
    </Box>
  );
}
