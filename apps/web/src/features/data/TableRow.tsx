"use client";

import ChevronRight from "@mui/icons-material/ChevronRight";
import ExpandMore from "@mui/icons-material/ExpandMore";
import TableChartOutlined from "@mui/icons-material/TableChartOutlined";
import ButtonBase from "@mui/material/ButtonBase";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import type { CatalogTable } from "@/lib/catalogToml";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { MouseEvent } from "react";

import { sectionOf } from "@/features/shell/sections";

import { tableHref, wrangleHref } from "./links";
import { TreeRow, type MenuAnchor } from "./TreeRow";

/**
 * A table of the catalog: its columns toggle, its link (named by its schema, if any), and a "…" menu.
 * In the wrangler the link opens the table there instead of on its Data page.
 */
export function TableRow({
  table,
  active,
  indent,
  open,
  onToggle,
  onMenu,
}: {
  table: CatalogTable;
  active: boolean;
  indent: number;
  open: boolean;
  onToggle(): void;
  onMenu(e: MouseEvent<HTMLElement>, anchor: MenuAnchor): void;
}) {
  const href = sectionOf(usePathname()) === "wrangle" ? wrangleHref(table.name) : tableHref(table.name);
  return (
    <TreeRow active={active} indent={indent} menuLabel={`actions for ${table.name}`} onMenu={onMenu}>
      <IconButton aria-label={`${open ? "hide" : "show"} the columns of ${table.name}`} onClick={onToggle} sx={{ p: 0.25, ml: 0.5, color: "text.disabled" }}>
        {open ? <ExpandMore sx={{ fontSize: 16 }} /> : <ChevronRight sx={{ fontSize: 16 }} />}
      </IconButton>
      <ButtonBase
        component={Link}
        href={href}
        aria-label={table.name}
        title={`${table.format} · ${table.path}`}
        sx={{ flex: 1, minWidth: 0, justifyContent: "flex-start", gap: 0.75, py: 0.45, pr: 3.5, pl: 0.25 }}
      >
        <TableChartOutlined sx={{ fontSize: 16, color: "primary.main" }} />
        <Typography noWrap sx={{ fontSize: 13 }}>
          {table.table}
        </Typography>
        {table.format === "csv" && (
          <Typography sx={{ fontSize: 10.5, color: "text.disabled", textTransform: "uppercase", letterSpacing: 0.4 }}>csv</Typography>
        )}
      </ButtonBase>
    </TreeRow>
  );
}
