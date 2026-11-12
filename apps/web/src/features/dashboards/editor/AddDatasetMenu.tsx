"use client";

import Add from "@mui/icons-material/Add";
import Button from "@mui/material/Button";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { Recipe } from "@/lib/dashboards/types";

import { DatasetDialog, type DatasetMode } from "./DatasetDialog";

/** "Add dataset": a SQL query, a whole table, or a table cleaned without code. */
export function AddDatasetMenu({ taken, tables, onCreate }: { taken: string[]; tables: string[] | null; onCreate(name: string, content: string | Recipe): Promise<boolean> }) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  // the mode stays while the dialog fades out
  const [mode, setMode] = useState<DatasetMode>("sql");
  const [open, setOpen] = useState(false);
  const choose = (next: DatasetMode) => {
    setAnchor(null);
    setMode(next);
    setOpen(true);
  };
  return (
    <>
      <Button variant="contained" size="small" fullWidth startIcon={<Add />} onClick={(e) => setAnchor(e.currentTarget)} aria-haspopup="menu">
        {t("Add dataset")}
      </Button>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
        <MenuItem onClick={() => choose("sql")}>{t("SQL query")}</MenuItem>
        <MenuItem onClick={() => choose("table")}>{t("From a table")}</MenuItem>
        <MenuItem onClick={() => choose("recipe")}>{t("From a table, cleaned (no code)")}</MenuItem>
      </Menu>
      <DatasetDialog open={open} mode={mode} taken={taken} tables={tables} onCreate={onCreate} onClose={() => setOpen(false)} />
    </>
  );
}
