"use client";

import ChevronRight from "@mui/icons-material/ChevronRight";
import ExpandMore from "@mui/icons-material/ExpandMore";
import Inventory2Outlined from "@mui/icons-material/Inventory2Outlined";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";

import type { CatalogGroup } from "./schemaGroups";
import { TreeRow, type MenuAnchor } from "./TreeRow";

/** A catalog of the tree: a folder that opens to its schemas, marked "default" for the workspace's own, and a "…" menu. */
export function CatalogRow({
  catalog,
  open,
  onToggle,
  onMenu,
}: {
  catalog: CatalogGroup;
  open: boolean;
  onToggle(): void;
  onMenu(e: MouseEvent<HTMLElement>, anchor: MenuAnchor): void;
}) {
  const { t } = useTranslation();
  const count = catalog.schemas.reduce((n, s) => n + s.tables.length, 0);
  return (
    <TreeRow active={false} indent={0} menuLabel={`actions for catalog ${catalog.name}`} onMenu={onMenu}>
      <ButtonBase
        aria-expanded={open}
        onClick={onToggle}
        title={catalog.description ?? undefined}
        sx={{ flex: 1, minWidth: 0, justifyContent: "flex-start", gap: 0.75, py: 0.6, pr: 3.5, pl: 0.5 }}
      >
        {open ? <ExpandMore sx={{ fontSize: 16, color: "text.disabled" }} /> : <ChevronRight sx={{ fontSize: 16, color: "text.disabled" }} />}
        <Inventory2Outlined sx={{ fontSize: 16, color: "text.secondary" }} />
        <Typography noWrap sx={{ fontSize: 13, fontWeight: 700 }}>
          {catalog.name}
        </Typography>
        {catalog.isDefault && (
          <Typography sx={{ fontSize: 10.5, color: "text.disabled", textTransform: "uppercase", letterSpacing: 0.4 }}>{t("default")}</Typography>
        )}
        <Typography sx={{ fontSize: 11, color: "text.disabled", ml: "auto", flexShrink: 0 }}>{count}</Typography>
      </ButtonBase>
    </TreeRow>
  );
}
