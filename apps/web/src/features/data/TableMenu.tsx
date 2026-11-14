"use client";

import ContentCopyOutlined from "@mui/icons-material/ContentCopyOutlined";
import DeleteOutline from "@mui/icons-material/DeleteOutlineOutlined";
import LockOutlined from "@mui/icons-material/LockOutlined";
import TableChartOutlined from "@mui/icons-material/TableChartOutlined";
import TerminalOutlined from "@mui/icons-material/TerminalOutlined";
import Divider from "@mui/material/Divider";
import Menu from "@mui/material/Menu";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useAccount } from "@/features/shell/account";
import { useNotify } from "@/features/shell/notify";
import { SYSTEM_CATALOG } from "@/lib/catalogConfig";
import type { CatalogTable } from "@/lib/catalogToml";

import { ActionItem } from "./ActionItem";
import { sampleQuery, sqlHref, tableHref } from "./links";
import { PermissionsDialog } from "./PermissionsDialog";
import { RemoveTableDialog } from "./RemoveTableDialog";
import type { MenuAnchor } from "./TreeRow";

export interface TableMenuTarget {
  table: CatalogTable;
  anchor: MenuAnchor;
}

/** Actions on a catalog table: open, query, copy its name, remove it from the catalog. The `system` catalog is read-only. */
export function TableMenu({ target, onClose }: { target: TableMenuTarget | null; onClose(): void }) {
  const { t } = useTranslation();
  const [removing, setRemoving] = useState<CatalogTable | null>(null);
  const [granting, setGranting] = useState<string | null>(null);
  const { admin } = useAccount();
  const router = useRouter();
  const notify = useNotify();
  const system = target?.table.catalog === SYSTEM_CATALOG;
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
        <ActionItem icon={<TableChartOutlined fontSize="small" />} label={t("Open")} onClick={run((tRow) => router.push(tableHref(tRow.name)))} />
        <ActionItem icon={<TerminalOutlined fontSize="small" />} label={t("Query in the SQL editor")} onClick={run((tRow) => router.push(sqlHref(sampleQuery(tRow.name))))} />
        <ActionItem
          icon={<ContentCopyOutlined fontSize="small" />}
          label={t("Copy name")}
          onClick={run(async (tRow) => {
            await navigator.clipboard.writeText(tRow.name);
            notify(`Copied ${tRow.name}`, "success");
          })}
        />
        {admin && <ActionItem icon={<LockOutlined fontSize="small" />} label={t("Permissions…")} onClick={run((tRow) => setGranting(tRow.full))} />}
        {!system && (
          <>
            <Divider />
            <ActionItem
              icon={<DeleteOutline fontSize="small" />}
              label={t("Remove from catalog…")}
              onClick={run((tRow) => setRemoving(tRow))}
              danger
              disabled={!!target?.table.discovered}
            />
          </>
        )}
      </Menu>
      <RemoveTableDialog table={removing} onClose={() => setRemoving(null)} />
      <PermissionsDialog open={granting !== null} on={granting ?? ""} onClose={() => setGranting(null)} />
    </>
  );
}

