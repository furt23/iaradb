"use client";

import ChevronRight from "@mui/icons-material/ChevronRight";
import ExpandMore from "@mui/icons-material/ExpandMore";
import FolderOutlined from "@mui/icons-material/FolderOutlined";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import type { MouseEvent } from "react";

import type { SchemaGroup } from "./schemaGroups";
import { TreeRow, type MenuAnchor } from "./TreeRow";

/** A schema of the catalog: a folder that opens to its tables, and a "…" menu. */
export function SchemaRow({
  group,
  open,
  onToggle,
  onMenu,
}: {
  group: SchemaGroup;
  open: boolean;
  onToggle(): void;
  onMenu(e: MouseEvent<HTMLElement>, anchor: MenuAnchor): void;
}) {
  return (
    <TreeRow active={false} indent={0} menuLabel={`actions for schema ${group.schema}`} onMenu={onMenu}>
      <ButtonBase
        aria-expanded={open}
        onClick={onToggle}
        title={group.description ?? undefined}
        sx={{ flex: 1, minWidth: 0, justifyContent: "flex-start", gap: 0.75, py: 0.6, pr: 3.5, pl: 0.5 }}
      >
        {open ? <ExpandMore sx={{ fontSize: 16, color: "text.disabled" }} /> : <ChevronRight sx={{ fontSize: 16, color: "text.disabled" }} />}
        <FolderOutlined sx={{ fontSize: 16, color: "text.secondary" }} />
        <Typography noWrap sx={{ fontSize: 13, fontWeight: 600 }}>
          {group.schema}
        </Typography>
        <Typography sx={{ fontSize: 11, color: "text.disabled", ml: "auto", flexShrink: 0 }}>{group.tables.length}</Typography>
      </ButtonBase>
    </TreeRow>
  );
}
