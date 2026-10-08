"use client";

import Add from "@mui/icons-material/Add";
import MenuBookOutlined from "@mui/icons-material/MenuBookOutlined";
import StorageOutlined from "@mui/icons-material/StorageOutlined";
import TerminalOutlined from "@mui/icons-material/TerminalOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import type { HistoryEntry, KernelInfo } from "@workhouse/protocol";
import Link from "next/link";
import { useState, type ReactNode } from "react";

import { NewNotebookDialog } from "@/features/files/NewNotebookDialog";
import { LocalTime } from "@/features/shell/LocalTime";
import { formatDuration } from "@/lib/format";

function Card({ title, icon, action, children }: { title: string; icon: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Box sx={{ color: "secondary.main", display: "flex" }}>{icon}</Box>
        <Typography variant="h4" sx={{ flex: 1 }}>
          {title}
        </Typography>
        {action}
      </Box>
      {children}
    </Paper>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <Typography variant="body2" sx={{ color: "text.secondary" }}>
      {children}
    </Typography>
  );
}

export interface HomeViewProps {
  info: KernelInfo | null;
  infoError: string | null;
  notebooks: string[];
  history: HistoryEntry[];
}

export function HomeView({ info, infoError, notebooks, history }: HomeViewProps) {
  const [creating, setCreating] = useState(false);
  return (
    <Box sx={{ p: 3, display: "flex", flexDirection: "column", gap: 3, overflow: "auto", flex: 1 }}>
      <Box>
        <Typography variant="overline" sx={{ color: "secondary.main" }}>
          Workhouse Studio
        </Typography>
        <Typography variant="h1">{info?.name ?? "Workspace"}</Typography>
        <Typography variant="body2" sx={{ color: "text.secondary", fontFamily: "'JetBrains Mono Variable', monospace" }}>
          {info ? `${info.root} · engine ${info.version}` : infoError}
        </Typography>
      </Box>
      <Box sx={{ display: "flex", gap: 1 }}>
        <Button variant="contained" color="secondary" startIcon={<Add />} onClick={() => setCreating(true)}>
          New notebook
        </Button>
        <Button variant="outlined" startIcon={<TerminalOutlined />} component={Link} href="/sql">
          SQL editor
        </Button>
        <Button variant="outlined" startIcon={<StorageOutlined />} component={Link} href="/catalog">
          Catalog
        </Button>
      </Box>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr 1.4fr" }, gap: 2 }}>
        <Card title="Notebooks" icon={<MenuBookOutlined />}>
          {notebooks.length === 0 && <Empty>No notebooks yet.</Empty>}
          {notebooks.slice(0, 12).map((p) => (
            <Typography key={p} component={Link} href={`/notebooks/${p.split("/").map(encodeURIComponent).join("/")}`} sx={{ color: "text.primary", textDecoration: "none", "&:hover": { color: "secondary.main" } }}>
              {p}
            </Typography>
          ))}
        </Card>
        <Card title="Catalog" icon={<StorageOutlined />}>
          {info && info.tables.length === 0 && <Empty>No tables yet: add Parquet or CSV datasets to workhouse.toml.</Empty>}
          {info?.tables.map((t) => (
            <Box key={t.name} sx={{ display: "flex", gap: 1, alignItems: "baseline" }}>
              <Typography component={Link} href={`/catalog/${t.name}`} sx={{ color: "text.primary", fontWeight: 600, textDecoration: "none", "&:hover": { color: "secondary.main" } }}>
                {t.name}
              </Typography>
              <Typography variant="mono" noWrap sx={{ color: "text.disabled", fontSize: 11 }}>
                {t.format} · {t.path}
              </Typography>
            </Box>
          ))}
        </Card>
        <Card title="Recent queries" icon={<TerminalOutlined />} action={<Button component={Link} href="/history" size="small">All</Button>}>
          {history.length === 0 && <Empty>Queries you run show up here.</Empty>}
          {history.slice(0, 6).map((h, i) => (
            <Box key={i} sx={{ borderBottom: 1, borderColor: "divider", pb: 0.75 }}>
              <Typography variant="mono" noWrap component="div" sx={{ color: h.error ? "error.main" : "text.primary" }}>
                {h.query.replace(/\s+/g, " ")}
              </Typography>
              <Typography variant="body2" sx={{ color: "text.disabled", fontSize: 11 }}>
                <LocalTime ms={h.ts * 1000} /> · {h.source} · {h.error ? "failed" : `${h.rows ?? 0} rows in ${formatDuration(h.elapsed_ms)}`}
              </Typography>
            </Box>
          ))}
        </Card>
      </Box>
      <NewNotebookDialog open={creating} onClose={() => setCreating(false)} />
    </Box>
  );
}
