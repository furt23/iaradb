"use client";

import WarningAmberOutlined from "@mui/icons-material/WarningAmberOutlined";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useState, type DragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { carriesField, FIELD_MIME, parseField, type FieldRef } from "./fieldDrag";

/**
 * The card around a widget: a header with its title (the grid drags by the
 * `dash-drag` part of it), a warning for the author's `notes` (editor only),
 * and the widget's own actions, then the body. A widget without a title has a
 * header only as a thin strip to drag it by. With `onFieldDrop` a field dragged
 * from the editor's Fields pane can be dropped on it, and it is outlined while
 * one is over it.
 */
export function WidgetFrame({
  title,
  selected,
  draggable,
  onClick,
  notes,
  actions,
  onFieldDrop,
  children,
}: {
  title?: string;
  selected?: boolean;
  draggable?: boolean;
  onClick?(): void;
  notes?: string[];
  actions?: ReactNode;
  onFieldDrop?(field: FieldRef): void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [over, setOver] = useState(false);
  const drop = onFieldDrop && {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!carriesField(e.dataTransfer.types)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setOver(true);
    },
    // moving onto the widget's own children is not leaving it
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      setOver(false);
      const field = parseField(e.dataTransfer.getData(FIELD_MIME));
      if (!field) return;
      e.preventDefault();
      onFieldDrop(field);
    },
  };
  const header = title || actions || draggable || notes?.length;
  return (
    <Paper
      variant="outlined"
      component="section"
      aria-label={title}
      onClick={onClick}
      {...drop}
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        outline: selected || over ? 2 : 0,
        outlineStyle: over ? "dashed" : "solid",
        outlineColor: "primary.main",
        outlineOffset: -1,
        bgcolor: over ? "action.hover" : undefined,
      }}
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
          {notes?.length ? (
            <Tooltip title={<Box component="ul" sx={{ m: 0, pl: 2 }}>{notes.map((n, i) => <li key={i}>{t(n)}</li>)}</Box>}>
              {/* focusable, so the notes can be read from the keyboard too */}
              <WarningAmberOutlined tabIndex={0} role="img" aria-label={t("Notes")} aria-hidden={false} color="warning" fontSize="small" sx={{ mx: 0.5, flexShrink: 0 }} />
            </Tooltip>
          ) : null}
          {actions}
        </Box>
      )}
      <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>{children}</Box>
    </Paper>
  );
}
