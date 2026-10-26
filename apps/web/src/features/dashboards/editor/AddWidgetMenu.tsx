"use client";

import Add from "@mui/icons-material/Add";
import BarChartOutlined from "@mui/icons-material/BarChartOutlined";
import FilterAltOutlined from "@mui/icons-material/FilterAltOutlined";
import NumbersOutlined from "@mui/icons-material/NumbersOutlined";
import TableChartOutlined from "@mui/icons-material/TableChartOutlined";
import TextFieldsOutlined from "@mui/icons-material/TextFieldsOutlined";
import Button from "@mui/material/Button";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Typography from "@mui/material/Typography";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { NewKind } from "./newWidget";

const KINDS: { kind: NewKind; label: string; icon: ReactNode }[] = [
  { kind: "chart", label: "Chart", icon: <BarChartOutlined fontSize="small" /> },
  { kind: "counter", label: "Counter", icon: <NumbersOutlined fontSize="small" /> },
  { kind: "table", label: "Table", icon: <TableChartOutlined fontSize="small" /> },
  { kind: "text", label: "Text", icon: <TextFieldsOutlined fontSize="small" /> },
  { kind: "filter", label: "Filter", icon: <FilterAltOutlined fontSize="small" /> },
];

/** The "Add" button of the canvas: what kind of widget to put on it. Everything but text needs a dataset. */
export function AddWidgetMenu({ hasDatasets, onAdd }: { hasDatasets: boolean; onAdd(kind: NewKind): void }) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <Button variant="contained" size="small" startIcon={<Add />} onClick={(e) => setAnchor(e.currentTarget)} aria-haspopup="menu">
        {t("Add")}
      </Button>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
        {KINDS.map((k) => (
          <MenuItem
            key={k.kind}
            disabled={k.kind !== "text" && !hasDatasets}
            onClick={() => {
              setAnchor(null);
              onAdd(k.kind);
            }}
          >
            <ListItemIcon>{k.icon}</ListItemIcon>
            <ListItemText>{t(k.label)}</ListItemText>
          </MenuItem>
        ))}
        {!hasDatasets && (
          <Typography variant="body2" sx={{ px: 2, pt: 1, maxWidth: 220, color: "text.secondary" }}>
            {t("Add a dataset in the Data tab to use the others.")}
          </Typography>
        )}
      </Menu>
    </>
  );
}
