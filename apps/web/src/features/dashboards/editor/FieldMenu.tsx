"use client";

import Divider from "@mui/material/Divider";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import { useTranslation } from "react-i18next";

import type { MenuAnchor } from "./FieldRow";

/** What a menu of the Fields pane is for. */
export type FieldTarget = { kind: "dataset"; name: string } | { kind: "column"; dataset: string; name: string; type: string } | { kind: "measure"; name: string };

export type FieldCommand = "new" | "quick" | "edit" | "rename" | "delete";

/** The commands of each kind of item. */
const COMMANDS: Record<FieldTarget["kind"], FieldCommand[]> = {
  dataset: ["new", "quick"],
  column: ["quick"],
  measure: ["edit", "rename", "quick", "delete"],
};

const LABEL: Record<FieldCommand, string> = { new: "New measure", quick: "Quick measure", edit: "Edit", rename: "Rename", delete: "Delete" };

/** The menu of an item of the Fields pane, open under its anchor (the pointer or an element) while there is a target. */
export function FieldMenu({ open, onClose, onCommand }: { open: { target: FieldTarget; anchor: MenuAnchor } | null; onClose(): void; onCommand(command: FieldCommand, target: FieldTarget): void }) {
  const { t } = useTranslation();
  const anchor = open?.anchor;
  return (
    <Menu
      open={open !== null}
      onClose={onClose}
      anchorReference={anchor && "el" in anchor ? "anchorEl" : "anchorPosition"}
      anchorEl={anchor && "el" in anchor ? anchor.el : undefined}
      anchorPosition={anchor && !("el" in anchor) ? anchor : undefined}
      slotProps={{ list: { dense: true, "aria-label": open ? `${t("Actions for")} ${open.target.name}` : undefined } }}
    >
      {open?.target &&
        COMMANDS[open.target.kind].flatMap((command) => [
          command === "delete" ? <Divider key="divider" /> : null,
          <MenuItem
            key={command}
            onClick={() => {
              onClose();
              onCommand(command, open.target);
            }}
            sx={command === "delete" ? { color: "error.main" } : undefined}
          >
            {t(LABEL[command])}
          </MenuItem>,
        ])}
    </Menu>
  );
}
