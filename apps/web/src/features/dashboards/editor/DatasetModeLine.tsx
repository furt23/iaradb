"use client";

import Check from "@mui/icons-material/Check";
import SwapHorizOutlined from "@mui/icons-material/SwapHorizOutlined";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { formatBytes, formatCount, formatRelative } from "@/lib/format";
import type { DatasetExtractStatus } from "@/server/actions/extracts";

type Mode = "extract" | "live";

/** Under a dataset's name: imported (a stored copy for viewers) or live (every view runs the query). */
export function DatasetModeLine({ status }: { status: DatasetExtractStatus | undefined }) {
  const { t } = useTranslation();
  if (!status) return null;
  const { mode, fresh, stale } = status;
  const text =
    mode === "live"
      ? t("Live")
      : mode === "params"
        ? t("Live · it has parameters")
        : fresh
          ? t("Imported · {{rows}} rows · {{size}} · updated {{when}}", { rows: formatCount(fresh.rows), size: formatBytes(fresh.bytes), when: formatRelative(fresh.refreshed_at) })
          : stale
            ? t("Imported · updates when you publish")
            : t("Imported · first import when you publish");
  return (
    <Tooltip title={t("Imported: viewers get a stored copy of the data, updated when you publish and on the refresh schedule. Live: every view runs the query.")}>
      <Typography component="span" noWrap sx={{ display: "block", fontSize: 12, color: "text.secondary" }}>
        {text}
      </Typography>
    </Tooltip>
  );
}

/** Switches a dataset between imported and live. Not offered for a dataset with parameters of its own. */
export function DatasetModeButton({ name, status, onChange }: { name: string; status: DatasetExtractStatus; onChange(mode: Mode): void }) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (status.mode === "params") return null;
  const choose = (mode: Mode) => {
    setAnchor(null);
    if (mode !== status.mode) onChange(mode);
  };
  return (
    <>
      <Tooltip title={t("How viewers get the data")}>
        <IconButton size="small" aria-label={`${t("How viewers get the data")}: ${name}`} aria-haspopup="menu" onClick={(e) => setAnchor(e.currentTarget)}>
          <SwapHorizOutlined fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
        {(["extract", "live"] as const).map((mode) => (
          <MenuItem key={mode} role="menuitemradio" aria-checked={status.mode === mode} onClick={() => choose(mode)}>
            <ListItemIcon>{status.mode === mode && <Check fontSize="small" />}</ListItemIcon>
            <ListItemText>{mode === "extract" ? t("Imported") : t("Live")}</ListItemText>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
