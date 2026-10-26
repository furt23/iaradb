"use client";

import CreateNewFolderOutlined from "@mui/icons-material/CreateNewFolderOutlined";
import DeleteOutline from "@mui/icons-material/DeleteOutlineOutlined";
import LockOutlined from "@mui/icons-material/LockOutlined";
import Divider from "@mui/material/Divider";
import Menu from "@mui/material/Menu";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useAccount } from "@/features/shell/account";
import { useGuard, useNotify } from "@/features/shell/notify";
import { MAIN_SCHEMA } from "@/lib/catalogToml";
import { unwrap } from "@/lib/action";
import { removeCatalog } from "@/server/actions/catalog";

import { ActionItem } from "./ActionItem";
import { NewSchemaDialog } from "./NewSchemaDialog";
import { PermissionsDialog } from "./PermissionsDialog";
import type { CatalogGroup } from "./schemaGroups";
import type { MenuAnchor } from "./TreeRow";

export interface CatalogMenuTarget {
  catalog: CatalogGroup;
  anchor: MenuAnchor;
}

/**
 * Actions on a catalog: add a schema to it, or remove it. The default catalog is the
 * workspace's own and stays; a catalog keeps its tables and schemas, so it is removed
 * only when it holds nothing but `main`.
 */
export function CatalogMenu({ target, onClose }: { target: CatalogMenuTarget | null; onClose(): void }) {
  const { t } = useTranslation();
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [granting, setGranting] = useState<string | null>(null);
  const { admin } = useAccount();
  const guard = useGuard();
  const notify = useNotify();
  const router = useRouter();
  const anchor = target?.anchor;
  const point = anchor && "x" in anchor ? anchor : null;
  const run = (fn: (c: CatalogGroup) => void | Promise<void>) => () => {
    if (!target) return;
    onClose();
    void fn(target.catalog);
  };
  const remove = (c: CatalogGroup) =>
    guard(async () => {
      unwrap(await removeCatalog(c.name));
      notify(`Removed catalog ${c.name}`, "success");
      router.refresh();
    });
  const holds = !!target && target.catalog.schemas.some((s) => s.tables.length > 0 || s.schema !== MAIN_SCHEMA);
  const isDefault = !!target?.catalog.isDefault;
  return (
    <>
      <Menu
        open={target !== null}
        onClose={onClose}
        anchorEl={anchor && !point ? (anchor as HTMLElement) : null}
        anchorReference={point ? "anchorPosition" : "anchorEl"}
        anchorPosition={point ? { top: point.y, left: point.x } : undefined}
        slotProps={{ list: { dense: true, "aria-label": target ? `actions for catalog ${target.catalog.name}` : undefined } }}
      >
        <ActionItem icon={<CreateNewFolderOutlined fontSize="small" />} label={t("New schema here…")} onClick={run((c) => setCreatingIn(c.name))} />
        {admin && <ActionItem icon={<LockOutlined fontSize="small" />} label={t("Permissions…")} onClick={run((c) => setGranting(c.name))} />}
        <Divider />
        <ActionItem
          icon={<DeleteOutline fontSize="small" />}
          label={t("Remove catalog")}
          onClick={run(remove)}
          danger
          disabled={isDefault || holds}
          hint={!isDefault && holds ? t("Remove its tables and schemas first") : undefined}
        />
      </Menu>
      <NewSchemaDialog open={creatingIn !== null} catalog={creatingIn ?? undefined} onClose={() => setCreatingIn(null)} />
      <PermissionsDialog open={granting !== null} on={granting ?? ""} onClose={() => setGranting(null)} />
    </>
  );
}
