"use client";

import ContentCopyOutlined from "@mui/icons-material/ContentCopyOutlined";
import DeleteOutline from "@mui/icons-material/DeleteOutlineOutlined";
import TableChartOutlined from "@mui/icons-material/TableChartOutlined";
import TerminalOutlined from "@mui/icons-material/TerminalOutlined";
import Divider from "@mui/material/Divider";
import Menu from "@mui/material/Menu";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useNotify } from "@/features/shell/notify";
import type { CatalogTable } from "@/lib/catalogToml";

import { ActionItem } from "./ActionItem";
import { sampleQuery, sqlHref, tableHref } from "./links";
import { RemoveTableDialog } from "./RemoveTableDialog";
import type { MenuAnchor } from "./TreeRow";

export interface TableMenuTarget {
  table: CatalogTable;
  anchor: MenuAnchor;
}

/** Actions on a catalog table: open, query, copy its name, remove it from the catalog. */
export function TableMenu({ target, onClose }: { target: TableMenuTarget | null; onClose(): void }) {
  const [removing, setRemoving] = useState<CatalogTable | null>(null);
  const router = useRouter();
  const notify = useNotify();
  const anchor = target?.anchor;
  const point = anchor && "x" in anchor ? anchor : null;
  const run = (fn: (t: CatalogTable) => void | Promise<void>) => () => {
    if (!target) return;
    onClose();
    void fn(target.table);
  };
  return (
    <>
      <Menu
        open={target !== null}
        onClose={onClose}
        anchorEl={anchor && !point ? (anchor as HTMLElement) : null}
        anchorReference={point ? "anchorPosition" : "anchorEl"}
        anchorPosition={point ? { top: point.y, left: point.x } : undefined}
        slotProps={{ list: { dense: true, "aria-label": target ? `actions for ${target.table.name}` : undefined } }}
      >
        <ActionItem icon={<TableChartOutlined fontSize="small" />} label="Open" onClick={run((t) => router.push(tableHref(t.name)))} />
        <ActionItem icon={<TerminalOutlined fontSize="small" />} label="Query in the SQL editor" onClick={run((t) => router.push(sqlHref(sampleQuery(t.name))))} />
        <ActionItem
          icon={<ContentCopyOutlined fontSize="small" />}
          label="Copy name"
          onClick={run(async (t) => {
            await navigator.clipboard.writeText(t.name);
            notify(`Copied ${t.name}`, "success");
          })}
        />
        <Divider />
        <ActionItem icon={<DeleteOutline fontSize="small" />} label="Remove from catalog…"
          onClick={run((t) => setRemoving(t))}
          danger
          disabled={!!target?.table.discovered}
          hint={target?.table.discovered ? "Discovered from the schema's location: delete the folder to remove the table" : undefined}
        />
      </Menu>
      <RemoveTableDialog table={removing} onClose={() => setRemoving(null)} />
    </>
  );
}
