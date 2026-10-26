"use client";

import AutoAwesomeOutlined from "@mui/icons-material/AutoAwesomeOutlined";
import EditOutlined from "@mui/icons-material/EditOutlined";
import EventRepeatOutlined from "@mui/icons-material/EventRepeatOutlined";
import OpenInNew from "@mui/icons-material/OpenInNew";
import RefreshRounded from "@mui/icons-material/RefreshRounded";
import SettingsOutlined from "@mui/icons-material/SettingsOutlined";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useCompute } from "@/features/compute/ComputeProvider";
import { PageHeader } from "@/features/shell/PageHeader";
import type { DashboardConfig } from "@/lib/dashboards/types";
import type { PublishedInfo } from "@/server/actions/dashboards";
import { viewLink } from "@/server/actions/viewLink";

/** The title; click to rename it (Enter or leaving the field saves, Escape keeps the old one). */
function Title({ value, onRename }: { value: string; onRename(title: string): void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);

  if (editing) {
    return (
      <TextField
        autoFocus
        size="small"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === "Escape") cancelled.current = true;
          if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLElement).blur();
        }}
        onBlur={() => {
          setEditing(false);
          const title = draft.trim();
          if (!cancelled.current && title && title !== value) onRename(title);
          cancelled.current = false;
        }}
        slotProps={{ htmlInput: { "aria-label": t("Dashboard title"), maxLength: 120 } }}
        sx={{ minWidth: 280 }}
      />
    );
  }
  return (
    <Tooltip title={t("Rename")}>
      <ButtonBase
        aria-label={`${t("Rename")}: ${value}`}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        sx={{ font: "inherit", gap: 1, maxWidth: "100%", borderRadius: 1, "& .rename": { opacity: 0 }, "&:hover .rename, &:focus-visible .rename": { opacity: 0.6 } }}
      >
        <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis" }}>
          {value}
        </Box>
        <EditOutlined className="rename" sx={{ fontSize: 16 }} />
      </ButtonBase>
    </Tooltip>
  );
}

/** Title, cluster, settings, refresh, its schedule, ask and publish of the dashboard being edited. */
export function EditorHeader({
  config,
  published,
  loading,
  onConfig,
  onRefresh,
  onSettings,
  onSchedule,
  onAsk,
  onPublish,
}: {
  config: DashboardConfig;
  published: PublishedInfo | null;
  loading: boolean;
  onConfig(config: DashboardConfig): void;
  onRefresh(): void;
  onSettings(): void;
  onSchedule(): void;
  onAsk(): void;
  onPublish(): void;
}) {
  const { t } = useTranslation();
  const clusters = (useCompute().overview?.clusters ?? []).filter((c) => !c.job);
  // on the view host when the Studio has one; until it answers (or if it fails) this Studio's own /view works for editors
  const [viewHref, setViewHref] = useState(`/view/${config.id}`);
  useEffect(() => {
    if (!published) return;
    let current = true;
    void viewLink(config.id).then((r) => current && r.ok && setViewHref(r.data));
    return () => {
      current = false;
    };
  }, [published, config.id]);
  return (
    <PageHeader
      title={
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
          <Title value={config.title} onRename={(title) => onConfig({ ...config, title })} />
          {published && <Chip size="small" color="success" variant="outlined" label={t("Published")} />}
        </Box>
      }
      subtitle={config.description}
      actions={
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexShrink: 0 }}>
          <TextField select size="small" label={t("Cluster")} value={config.cluster ?? ""} onChange={(e) => onConfig({ ...config, cluster: e.target.value || undefined })} sx={{ minWidth: 170 }}>
            <MenuItem value="">{t("Default cluster")}</MenuItem>
            {config.cluster && !clusters.some((c) => c.id === config.cluster) && <MenuItem value={config.cluster}>{config.cluster}</MenuItem>}
            {clusters.map((c) => (
              <MenuItem key={c.id} value={c.id}>
                {c.name}
              </MenuItem>
            ))}
          </TextField>
          <Tooltip title={t("Settings")}>
            <IconButton aria-label={t("Dashboard settings")} onClick={onSettings}>
              <SettingsOutlined fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={t("Refresh data")}>
            <span>
              <IconButton aria-label={t("Refresh data")} onClick={onRefresh} disabled={loading}>
                <RefreshRounded fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          {published && (
            <Button component="a" href={viewHref} target="_blank" rel="noopener noreferrer" startIcon={<OpenInNew />}>
              {t("Open view")}
            </Button>
          )}
          <Button startIcon={<EventRepeatOutlined />} onClick={onSchedule}>
            {t("Schedule refresh")}
          </Button>
          <Button startIcon={<AutoAwesomeOutlined />} onClick={onAsk}>
            {t("Ask")}
          </Button>
          <Button variant="contained" color="secondary" onClick={onPublish}>
            {t("Publish")}
          </Button>
        </Box>
      }
    />
  );
}
