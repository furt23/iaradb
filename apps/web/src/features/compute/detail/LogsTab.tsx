"use client";

import ContentCopy from "@mui/icons-material/ContentCopy";
import Refresh from "@mui/icons-material/Refresh";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Switch from "@mui/material/Switch";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useNotify } from "@/features/shell/notify";
import { type ClusterLogSource, clusterLogs } from "@/server/actions/clusters";
import type { ClusterView } from "@/server/compute/types";

const POLL_MS = 3000;
/** Within this many pixels of the end, the view counts as scrolled to the bottom. */
const BOTTOM_SLACK = 8;

/** The logs of a cluster (boot, init script, kernels), followed every few seconds while it runs. */
export function LogsTab({ cluster: c }: { cluster: ClusterView }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const local = c.kind === "local";
  const [chosen, setChosen] = useState<ClusterLogSource>("boot");
  const source: ClusterLogSource = local ? "kernels" : chosen;
  const [follow, setFollow] = useState(() => c.state === "starting" || c.state === "running");
  const [lines, setLines] = useState<string[]>([]);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const load = useCallback(async () => {
    const asked = source;
    const r = await clusterLogs(c.id, asked);
    if (asked !== sourceRef.current) return; // the user picked another source meanwhile
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    setError(null);
    setLines(r.data.lines);
    setUnavailable(r.data.unavailable ?? null);
  }, [c.id, source]);

  useEffect(() => {
    void load();
    if (!follow) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load, follow]);

  useEffect(() => {
    const el = viewRef.current;
    if (follow && el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  const onScroll = () => {
    const el = viewRef.current;
    if (el) atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_SLACK;
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      notify(t("Copied"), "success");
    } catch (e) {
      notify((e as Error).message, "error");
    }
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1.5 }}>
        {!local && (
          <ToggleButtonGroup size="small" exclusive value={source} onChange={(_, v: ClusterLogSource | null) => v && setChosen(v)} aria-label={t("log source")}>
            <ToggleButton value="boot">{t("Boot")}</ToggleButton>
            <ToggleButton value="init">{t("Init script")}</ToggleButton>
            <ToggleButton value="kernels">{t("Kernels")}</ToggleButton>
          </ToggleButtonGroup>
        )}
        <FormControlLabel control={<Switch size="small" checked={follow} onChange={(e) => setFollow(e.target.checked)} />} label={t("Follow")} />
        <Box sx={{ flexGrow: 1 }} />
        <IconButton aria-label={t("Refresh")} onClick={() => void load()}>
          <Refresh fontSize="small" />
        </IconButton>
        <IconButton aria-label={t("Copy")} onClick={() => void copy()} disabled={!lines.length}>
          <ContentCopy fontSize="small" />
        </IconButton>
      </Box>
      {error && <Alert severity="error">{error}</Alert>}
      {unavailable && <Alert severity="info">{unavailable}</Alert>}
      <Paper variant="outlined" ref={viewRef} onScroll={onScroll} sx={{ p: 1.5, maxHeight: "60vh", overflow: "auto" }}>
        {lines.length ? (
          <Typography component="pre" sx={{ m: 0, fontFamily: "monospace", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {lines.join("\n")}
          </Typography>
        ) : (
          <Typography sx={{ color: "text.secondary", fontSize: 14 }}>{t("No lines yet.")}</Typography>
        )}
      </Paper>
    </Box>
  );
}
