"use client";

import MoreVertOutlined from "@mui/icons-material/MoreVertOutlined";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Checkbox from "@mui/material/Checkbox";
import IconButton from "@mui/material/IconButton";
import type { DragEvent, KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { encodeField, FIELD_MIME, type FieldRef } from "../canvas/fieldDrag";
import type { FieldState } from "./fieldActions";

/** Where a menu opens: under an element (the ⋮ button, the row for the keyboard) or at the pointer. */
export type MenuAnchor = { el: HTMLElement } | { top: number; left: number };

const MARK = { fontFamily: "var(--font-mono, monospace)", fontSize: 10.5, minWidth: 22, textAlign: "center", flexShrink: 0 } as const;

/** The mark before a column's name: a short word for its type. */
export function TypeMark({ glyph, title }: { glyph: string; title: string }) {
  return (
    <Box component="span" role="img" aria-label={title} title={title} sx={{ ...MARK, color: "text.disabled" }}>
      {glyph}
    </Box>
  );
}

/** The mark before a measure's name. */
export function MeasureMark({ title }: { title: string }) {
  return (
    <Box component="span" role="img" aria-label={title} title={title} sx={{ ...MARK, fontSize: 11, fontWeight: 650, fontStyle: "italic", color: "primary.main" }}>
      ƒx
    </Box>
  );
}

/** What a row opens a menu with: right click, the Menu key or Shift+F10 on the row, or its ⋮ button. */
export function useMenuHandlers(onMenu: ((anchor: MenuAnchor) => void) | undefined) {
  return {
    onContextMenu: (e: MouseEvent<HTMLElement>) => {
      if (!onMenu) return;
      e.preventDefault();
      // a menu key press reports no position
      onMenu(e.clientX === 0 && e.clientY === 0 ? { el: e.currentTarget } : { top: e.clientY, left: e.clientX });
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (!onMenu || (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10"))) return;
      e.preventDefault();
      onMenu({ el: e.currentTarget });
    },
  };
}

export function MoreButton({ label, onMenu }: { label: string; onMenu(anchor: MenuAnchor): void }) {
  const { t } = useTranslation();
  return (
    <IconButton size="small" aria-label={`${t("Actions for")} ${label}`} aria-haspopup="menu" onClick={(e) => onMenu({ el: e.currentTarget })} sx={{ flexShrink: 0, opacity: 0.6, "&:hover, &:focus-visible": { opacity: 1 } }}>
      <MoreVertOutlined sx={{ fontSize: 16 }} />
    </IconButton>
  );
}

/**
 * A measure or a column in the tree. Draggable onto a widget. With a checkbox when the selected widget takes it
 * (`check`), a button that sets the chart's x (`pick`), else plain text. Its menu opens like any other.
 */
export function FieldRow({
  name,
  mark,
  field,
  state,
  onActivate,
  onMenu,
}: {
  name: string;
  mark: ReactNode;
  field: FieldRef;
  state: FieldState;
  onActivate?(): void;
  onMenu?(anchor: MenuAnchor): void;
}) {
  const menu = useMenuHandlers(onMenu);
  const picked = state?.control === "pick" && state.picked;
  const label = (
    <>
      {mark}
      <Box component="span" sx={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, textAlign: "left", fontWeight: picked ? 650 : 400, color: picked ? "primary.main" : "text.primary" }}>
        {name}
      </Box>
    </>
  );
  const row = { display: "flex", alignItems: "center", gap: 0.5, flex: 1, minWidth: 0, py: 0.25 } as const;
  return (
    <Box
      component="li"
      draggable
      onDragStart={(e: DragEvent<HTMLElement>) => {
        e.dataTransfer.setData(FIELD_MIME, encodeField(field));
        e.dataTransfer.setData("text/plain", name);
        e.dataTransfer.effectAllowed = "copy";
      }}
      {...menu}
      sx={{ display: "flex", alignItems: "center", pl: 2.5, pr: 0.5, borderRadius: 1, cursor: "grab", "&:hover": { bgcolor: "action.hover" } }}
    >
      {state?.control === "check" && (
        <Checkbox size="small" checked={state.checked} onChange={() => onActivate?.()} slotProps={{ input: { "aria-label": name } }} sx={{ p: 0.5, mr: 0.5 }} />
      )}
      {/* not a <button>: a drag cannot start on one in every browser */}
      {state?.control === "pick" ? (
        <ButtonBase component="div" onClick={onActivate} aria-pressed={picked} sx={{ ...row, borderRadius: 1 }}>
          {label}
        </ButtonBase>
      ) : (
        // the checkbox is the control; the name only follows it with the pointer
        <Box onClick={state?.control === "check" ? onActivate : undefined} sx={row}>
          {label}
        </Box>
      )}
      {onMenu && <MoreButton label={name} onMenu={onMenu} />}
    </Box>
  );
}
