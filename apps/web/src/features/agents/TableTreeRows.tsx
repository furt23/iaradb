"use client";

import ChevronRight from "@mui/icons-material/ChevronRight";
import ExpandMore from "@mui/icons-material/ExpandMore";
import FolderOutlined from "@mui/icons-material/FolderOutlined";
import StorageOutlined from "@mui/icons-material/StorageOutlined";
import TableChartOutlined from "@mui/icons-material/TableChartOutlined";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Checkbox from "@mui/material/Checkbox";
import Typography from "@mui/material/Typography";

import { useTranslation } from "@/i18n";

import { tableNameOf } from "./tableTree";

/** A row of the tree: 28px, its hover and selection tint. */
const row = (active: boolean) => ({
  display: "flex",
  alignItems: "center",
  gap: 0.5,
  height: 28,
  minWidth: 0,
  borderRadius: 1,
  pr: 1,
  bgcolor: active ? "action.selected" : "transparent",
  "&:hover": { bgcolor: active ? "action.selected" : "action.hover" },
});

const count = (n: number) => (
  <Typography sx={{ fontSize: 11, color: "text.disabled", ml: "auto", flexShrink: 0 }}>{n.toLocaleString()}</Typography>
);

/** A catalog: a database, not a toggle; its schemas are listed under it. */
export function CatalogTreeRow({ name, tables }: { name: string; tables: number }) {
  return (
    <Box sx={{ ...row(false), px: 1, mt: 0.5 }}>
      <StorageOutlined sx={{ fontSize: 16, color: "text.secondary" }} />
      <Typography noWrap sx={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700 }}>
        {name}
      </Typography>
      {count(tables)}
    </Box>
  );
}

/** A schema: a check that includes or leaves out all its tables (tri-state), and a folder that opens to them. */
export function SchemaTreeRow({
  schema,
  tables,
  includedCount,
  open,
  onToggle,
  onIncluded,
}: {
  schema: string;
  tables: number;
  includedCount: number;
  open: boolean;
  onToggle(): void;
  onIncluded(included: boolean): void;
}) {
  const { t } = useTranslation();
  const all = includedCount === tables;
  return (
    <Box sx={{ ...row(false), pl: 1 }}>
      <Checkbox
        size="small"
        sx={{ p: 0.25 }}
        checked={all}
        indeterminate={includedCount > 0 && !all}
        onChange={(e) => onIncluded(e.target.checked)}
        slotProps={{ input: { "aria-label": t("Include all of {{name}}", { name: schema }) } }}
      />
      <ButtonBase
        aria-expanded={open}
        onClick={onToggle}
        sx={{ flex: 1, minWidth: 0, height: 28, justifyContent: "flex-start", gap: 0.75, px: 0.5, borderRadius: 1 }}
      >
        {open ? <ExpandMore sx={{ fontSize: 16, color: "text.disabled" }} /> : <ChevronRight sx={{ fontSize: 16, color: "text.disabled" }} />}
        <FolderOutlined sx={{ fontSize: 16, color: "text.secondary" }} />
        <Typography noWrap sx={{ fontSize: 13, fontWeight: 600 }}>
          {schema}
        </Typography>
        {count(tables)}
      </ButtonBase>
    </Box>
  );
}

/** A table: a check to include it, its short name (bold when included), and its row count once read. */
export function TableTreeRow({
  name,
  included,
  active,
  rows,
  onSelect,
  onIncluded,
}: {
  name: string;
  included: boolean;
  active: boolean;
  rows: number | null;
  onSelect(): void;
  onIncluded(included: boolean): void;
}) {
  const { t } = useTranslation();
  return (
    <Box sx={{ ...row(active), pl: 4 }}>
      <Checkbox
        size="small"
        sx={{ p: 0.25 }}
        checked={included}
        onChange={(e) => onIncluded(e.target.checked)}
        slotProps={{ input: { "aria-label": t("Include {{name}}", { name }) } }}
      />
      <ButtonBase
        aria-pressed={active}
        title={name}
        onClick={onSelect}
        sx={{ flex: 1, minWidth: 0, height: 28, justifyContent: "flex-start", gap: 0.75, pl: 0.25, pr: 0.5, borderRadius: 1 }}
      >
        <TableChartOutlined sx={{ fontSize: 15, color: included ? "primary.main" : "text.disabled" }} />
        <Typography noWrap sx={{ fontSize: 13, fontWeight: included ? 600 : 400, color: included ? "text.primary" : "text.secondary" }}>
          {tableNameOf(name)}
        </Typography>
        {rows !== null && count(rows)}
      </ButtonBase>
    </Box>
  );
}
