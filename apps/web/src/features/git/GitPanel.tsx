"use client";

import CallSplit from "@mui/icons-material/CallSplit";
import Refresh from "@mui/icons-material/Refresh";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { LocalTime } from "@/features/shell/LocalTime";
import { PageHeader } from "@/features/shell/PageHeader";
import { useGuard, useNotify } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { gitCommit, gitDiff, gitRemoteSettings, type GitRemoteSettings } from "@/server/actions/git";
import type { GitFile, GitStatus } from "@/server/git/status";

import { DiffView } from "./DiffView";
import { RemoteBar } from "./RemoteBar";

function badge(f: GitFile, t: (k: string) => string): { label: string; color: "success" | "warning" | "error" | "info" } {
  const code = f.index !== " " && f.index !== "?" ? f.index : f.worktree;
  if (code === "?" || code === "A") return { label: t("new"), color: "success" };
  if (code === "D") return { label: t("deleted"), color: "error" };
  if (code === "R") return { label: t("renamed"), color: "info" };
  return { label: t("modified"), color: "warning" };
}

export interface GitPanelProps {
  status: GitStatus | null;
  error: string | null;
  log: { hash: string; subject: string; author: string; date: string }[];
}

export function GitPanel({ status, error, log }: GitPanelProps) {
  const { t } = useTranslation();
  const files = status?.files ?? [];
  const [selected, setSelected] = useState<Set<string>>(() => new Set(files.map((f) => f.path)));
  const [focus, setFocus] = useState<string | null>(files[0]?.path ?? null);
  const [diff, setDiff] = useState("");
  const [message, setMessage] = useState("");
  const [remote, setRemote] = useState<GitRemoteSettings | null>(null);

  const guard = useGuard();
  const notify = useNotify();
  const router = useRouter();

  useEffect(() => {
    let live = true;
    gitRemoteSettings().then((r) => {
      if (!live) return;
      if (r.ok) setRemote(r.data);
      else notify(r.error.message, "error");
    });
    return () => {
      live = false;
    };
  }, [notify]);

  useEffect(() => {
    if (!focus) return setDiff("");
    let live = true;
    gitDiff(focus).then((r) => live && setDiff(r.ok ? r.data : r.error.message));
    return () => {
      live = false;
    };
  }, [focus]);

  const toggle = (p: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  const commit = () =>
    guard(async () => {
      const hash = unwrap(await gitCommit(message, [...selected]));
      notify(`Committed ${hash}`, "success");
      setMessage("");
      router.refresh();
    });

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <PageHeader
        title={t("Git")}
        subtitle={status ? `on ${status.branch ?? "detached HEAD"}${status.upstream ? ` · tracking ${status.upstream} (+${status.ahead} −${status.behind})` : ""}` : "version control of the workspace"}
        actions={
          <Button startIcon={<Refresh />} onClick={() => router.refresh()} sx={{ color: "text.secondary" }}>
            {t("Refresh")}
          </Button>
        }
      />
      <RemoteBar remote={remote} status={status} onChanged={setRemote} />
      {error ? (
        <Box sx={{ p: 3 }}>
          <Typography sx={{ color: "error.main", whiteSpace: "pre-wrap", fontFamily: "'JetBrains Mono Variable', monospace", fontSize: 13 }}>{error}</Typography>
          <Typography sx={{ color: "text.secondary", mt: 1 }}>
            {t("The workspace is not a usable Git repository. Connect a repository above to create one, or check that Git trusts the workspace.")}
          </Typography>
        </Box>
      ) : (
        <Box sx={{ display: "grid", gridTemplateColumns: "340px 1fr", flex: 1, minHeight: 0 }}>
          <Box sx={{ borderRight: 1, borderColor: "divider", display: "flex", flexDirection: "column", minHeight: 0 }}>
            <Box sx={{ flex: 1, overflow: "auto" }}>
              {files.length === 0 && <Typography sx={{ p: 2, color: "text.secondary" }}>{t("Nothing to commit: the working tree is clean.")}</Typography>}
              {files.map((f) => {
                const b = badge(f, t);
                return (
                  <Box
                    key={f.path}
                    onClick={() => setFocus(f.path)}
                    sx={{ display: "flex", alignItems: "center", gap: 0.5, pr: 1, cursor: "pointer", bgcolor: focus === f.path ? "action.selected" : undefined, "&:hover": { bgcolor: "action.hover" } }}
                  >
                    <Checkbox size="small" checked={selected.has(f.path)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(f.path)} />
                    <Typography noWrap sx={{ flex: 1, fontSize: 13 }} title={f.path}>
                      {f.path}
                    </Typography>
                    <Chip label={b.label} color={b.color} variant="outlined" />
                  </Box>
                );
              })}
            </Box>
            <Box sx={{ p: 1.5, borderTop: 1, borderColor: "divider", display: "flex", flexDirection: "column", gap: 1 }}>
              <TextField multiline minRows={2} placeholder={t("Commit message")} value={message} onChange={(e) => setMessage(e.target.value)} />
              <Button variant="contained" color="secondary" startIcon={<CallSplit />} onClick={commit} disabled={!message.trim() || selected.size === 0}>
                {selected.size === 1 ? t("Commit {{count}} file", { count: selected.size }) : t("Commit {{count}} files", { count: selected.size })}
              </Button>
            </Box>
          </Box>
          <Box sx={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
            <Box sx={{ flex: 1, overflow: "auto" }}>{focus ? <DiffView diff={diff} /> : null}</Box>
            {log.length > 0 && (
              <Paper square variant="outlined" sx={{ borderLeft: 0, borderRight: 0, borderBottom: 0, maxHeight: 200, overflow: "auto", px: 2, py: 1 }}>
                <Typography variant="overline" sx={{ color: "text.disabled" }}>
                  {t("Recent commits")}
                </Typography>

                {log.map((c) => (
                  <Box key={c.hash} sx={{ display: "flex", gap: 1.5, py: 0.25 }}>
                    <Typography variant="mono" sx={{ color: "secondary.main" }}>
                      {c.hash}
                    </Typography>
                    <Typography noWrap sx={{ flex: 1, fontSize: 13 }}>
                      {c.subject}
                    </Typography>
                    <Typography sx={{ color: "text.disabled", fontSize: 12 }}>
                      <LocalTime ms={Date.parse(c.date)} />
                    </Typography>
                  </Box>
                ))}
              </Paper>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}
