"use client";

import Add from "@mui/icons-material/Add";
import DescriptionOutlined from "@mui/icons-material/DescriptionOutlined";
import MenuBookOutlined from "@mui/icons-material/MenuBookOutlined";
import PostAddOutlined from "@mui/icons-material/PostAddOutlined";
import StorageOutlined from "@mui/icons-material/StorageOutlined";
import TerminalOutlined from "@mui/icons-material/TerminalOutlined";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { useState, type ReactNode } from "react";

import { NewNotebookDialog } from "@/features/files/NewNotebookDialog";
import { NewQueryDialog } from "@/features/queries/NewQueryDialog";
import { baseName, parentOf } from "@/lib/paths";

import { useTranslation } from "@/i18n";
import { useWorkbench } from "./WorkbenchProvider";

function Action({ icon, title, hint, onClick, href }: { icon: ReactNode; title: string; hint?: string; onClick?(): void; href?: string }) {
  const link = href ? { component: Link, href } : {};
  return (
    <ButtonBase
      {...link}
      onClick={onClick}
      sx={{
        justifyContent: "flex-start",
        alignItems: "flex-start",
        gap: 1.25,
        p: 1.5,
        border: 1,
        borderColor: "divider",
        borderRadius: 2,
        textAlign: "left",
        "&:hover": { borderColor: "secondary.main", bgcolor: "action.hover" },
      }}
    >
      <Box sx={{ color: "secondary.main", display: "flex", mt: 0.25 }}>{icon}</Box>
      <Box>
        <Typography sx={{ fontWeight: 650, fontSize: 14 }}>{title}</Typography>
        {hint && (
          <Typography variant="body2" sx={{ color: "text.secondary", fontSize: 12 }}>
            {hint}
          </Typography>
        )}
      </Box>
    </ButtonBase>
  );
}

function FileRow({ path, onOpen }: { path: string; onOpen(): void }) {
  const sql = path.endsWith(".sql");
  return (
    <ButtonBase onClick={onOpen} sx={{ width: "100%", justifyContent: "flex-start", gap: 1, px: 1, py: 0.75, borderRadius: 1, "&:hover": { bgcolor: "action.hover" } }}>
      {sql ? <DescriptionOutlined sx={{ fontSize: 16, color: "primary.main" }} /> : <MenuBookOutlined sx={{ fontSize: 16, color: "secondary.main" }} />}
      <Typography noWrap sx={{ fontSize: 13 }}>
        {baseName(path)}
      </Typography>
      <Typography noWrap sx={{ fontSize: 12, color: "text.disabled", ml: "auto", pl: 2 }}>
        {parentOf(path) || "/"}
      </Typography>
    </ButtonBase>
  );
}

/** The workbench with nothing open: what to start with, and what was open lately. */
export function StartPane({ name, notebooks }: { name: string; notebooks: string[] }) {
  const { recent, act } = useWorkbench();
  const { t } = useTranslation();
  const [creating, setCreating] = useState<"notebook" | "query" | null>(null);
  const known = new Set(notebooks);
  const recentFiles = recent.filter((p) => known.has(p));
  const list = recentFiles.length ? recentFiles : notebooks.slice(0, 8);
  return (
    <Box sx={{ flex: 1, overflow: "auto", display: "flex", justifyContent: "center", p: 4 }}>
      <Box sx={{ width: "100%", maxWidth: 720, display: "flex", flexDirection: "column", gap: 3, pt: { md: 4 } }}>
        <Box>
          <Typography variant="overline" sx={{ color: "secondary.main" }}>
            {t("Workspace")}
          </Typography>
          <Typography variant="h2">{name}</Typography>
        </Box>
        <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 1.5 }}>
          <Action icon={<Add />} title={t("New notebook")} hint={t("Python and SQL cells")} onClick={() => setCreating("notebook")} />
          <Action icon={<PostAddOutlined />} title={t("New SQL query")} onClick={() => setCreating("query")} />
          <Action icon={<TerminalOutlined />} title={t("SQL editor")} href="/sql" />
          <Action icon={<StorageOutlined />} title={t("Browse data")} href="/data" />
        </Box>
        <Box>
          <Typography variant="overline" sx={{ color: "text.disabled" }}>
            {recentFiles.length ? t("Recent") : t("Notebooks")}
          </Typography>
          {list.length ? (
            list.map((p) => <FileRow key={p} path={p} onOpen={() => act({ type: "open", path: p }, true)} />)
          ) : (
            <Typography variant="body2" sx={{ color: "text.secondary", px: 1 }}>
              {t("No notebooks or queries yet.")}
            </Typography>
          )}
        </Box>
      </Box>
      <NewNotebookDialog open={creating === "notebook"} onClose={() => setCreating(null)} />
      <NewQueryDialog open={creating === "query"} onClose={() => setCreating(null)} />
    </Box>
  );
}
