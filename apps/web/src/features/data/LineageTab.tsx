"use client";

import DashboardOutlined from "@mui/icons-material/DashboardOutlined";
import DescriptionOutlined from "@mui/icons-material/DescriptionOutlined";
import Schedule from "@mui/icons-material/Schedule";
import SmartToyOutlined from "@mui/icons-material/SmartToyOutlined";
import TerminalOutlined from "@mui/icons-material/TerminalOutlined";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { LocalTime } from "@/features/shell/LocalTime";
import { fileHref } from "@/features/workbench/fileIdRegistry";
import type { LineageSource, LineageUse, TableLineage } from "@/lib/system/types";
import { tableLineage } from "@/server/actions/lineage";

import { LoadFailure } from "./LoadFailure";
import type { Load } from "./DataProvider";
import { tableHref } from "./links";

const KIND: Record<LineageSource["kind"], { label: string; icon: ReactNode }> = {
  notebook: { label: "Notebook", icon: <DescriptionOutlined fontSize="small" /> },
  sql: { label: "SQL", icon: <TerminalOutlined fontSize="small" /> },
  job: { label: "Job", icon: <Schedule fontSize="small" /> },
  dashboard: { label: "Dashboard", icon: <DashboardOutlined fontSize="small" /> },
  assistant: { label: "Iara", icon: <SmartToyOutlined fontSize="small" /> },
  other: { label: "Other", icon: <DescriptionOutlined fontSize="small" /> },
};

/** A notebook or job links to its page; a dashboard is known only by its id, so it stays text. */
function sourceHref(source: LineageSource): string | null {
  if (source.kind === "notebook") return fileHref(source.id);
  if (source.kind === "job") return `/jobs/${encodeURIComponent(source.id)}`;
  return null;
}

function UseRow({ use }: { use: LineageUse }) {
  const { t } = useTranslation();
  const { source } = use;
  const href = sourceHref(source);
  const label = href ? (
    <Typography component={Link} href={href} sx={{ fontSize: 13, color: "text.primary", textDecoration: "none", "&:hover": { color: "secondary.main" } }} noWrap>
      {source.label}
    </Typography>
  ) : (
    <Typography sx={{ fontSize: 13 }} noWrap>
      {source.label}
    </Typography>
  );
  return (
    <Box sx={{ display: "flex", gap: 1.5, alignItems: "center", py: 0.75, borderBottom: 1, borderColor: "divider", minWidth: 0 }}>
      <Tooltip title={t(KIND[source.kind].label)}>
        <Box sx={{ color: "text.secondary", display: "flex" }}>{KIND[source.kind].icon}</Box>
      </Tooltip>
      <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexWrap: "wrap", gap: 1, alignItems: "center" }}>
        <Box sx={{ minWidth: 0, maxWidth: "100%" }}>{label}</Box>
        {use.user && (
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {use.user}
          </Typography>
        )}
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          <LocalTime ms={use.ts} />
        </Typography>
        {use.version !== null && <Chip label={`v${use.version}`} size="small" variant="outlined" />}
        {use.inputs.map((input) => (
          <Chip key={input} label={input} size="small" component={Link} href={tableHref(input)} clickable variant="outlined" />
        ))}
      </Box>
    </Box>
  );
}

function Section({ title, uses }: { title: string; uses: LineageUse[] }) {
  if (uses.length === 0) return null;
  return (
    <Box sx={{ px: 3, pt: 2 }}>
      <Typography variant="overline" sx={{ color: "text.disabled", fontSize: 11, display: "block", lineHeight: 1.8 }}>
        {title}
      </Typography>
      {uses.map((u) => (
        <UseRow key={`${u.source.kind}:${u.source.id}`} use={u} />
      ))}
    </Box>
  );
}

/** The notebooks, queries, jobs, dashboards and chat runs that wrote or read a table. */
export function LineageTab({ name }: { name: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<Load<TableLineage>>({ status: "loading" });

  const refresh = useCallback(async () => {
    const r = await tableLineage(name);
    setState(r.ok ? { status: "ready", data: r.data } : { status: "failed", type: r.error.type, message: r.error.message });
  }, [name]);

  useEffect(() => {
    setState({ status: "loading" });
    void refresh();
  }, [refresh]);

  if (state.status === "loading") {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
        <CircularProgress size={22} />
      </Box>
    );
  }
  if (state.status === "failed") return <LoadFailure type={state.type} message={state.message} onRetry={() => void refresh()} />;
  const { writers, readers } = state.data;
  if (writers.length === 0 && readers.length === 0) {
    return (
      <Typography sx={{ px: 3, py: 3, color: "text.secondary", fontSize: 13 }}>{t("No run has read or written this table yet.")}</Typography>
    );
  }
  return (
    <Box sx={{ pb: 2 }}>
      <Section title={t("Written by")} uses={writers} />
      <Section title={t("Read by")} uses={readers} />
    </Box>
  );
}
