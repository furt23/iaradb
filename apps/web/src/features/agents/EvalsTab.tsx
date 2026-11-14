"use client";

import Search from "@mui/icons-material/Search";
import FactCheckOutlined from "@mui/icons-material/FactCheckOutlined";
import Refresh from "@mui/icons-material/Refresh";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useState } from "react";

import { useNotify } from "@/features/shell/notify";
import { useTranslation } from "@/i18n";
import type { AgentLogEntry } from "@/lib/agents/types";
import { listAgentLogAction } from "@/server/actions/agents";

import { SectionHeader, SectionLayout } from "./AgentSection";
import { EvalTable } from "./EvalTable";

/** "review": not rated yet */
type Filter = "all" | "review" | "good" | "bad";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "review", label: "To review" },
  { id: "good", label: "Good" },
  { id: "bad", label: "Bad" },
];
/** rows shown at a time */
const PAGE = 200;

const matches = (e: AgentLogEntry, f: Filter) => f === "all" || (f === "review" ? e.rating === null : e.rating === f);

/** Every question asked to the agent, rated. Opening one shows it in the left panel. */
export function EvalsTab({
  slug,
  openId,
  changed,
  onOpen,
}: {
  slug: string;
  openId: string | null;
  /** an entry the open evaluation rated or noted */
  changed: AgentLogEntry | null;
  onOpen(e: AgentLogEntry): void;
}) {
  const { t } = useTranslation();
  const notify = useNotify();
  const [entries, setEntries] = useState<AgentLogEntry[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);

  const reload = useCallback(async () => {
    const r = await listAgentLogAction(slug);
    if (r.ok) setEntries(r.data);
    else notify(r.error.message, "error");
  }, [slug, notify]);
  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (changed) setEntries((list) => list?.map((e) => (e.id === changed.id ? changed : e)) ?? null);
  }, [changed]);

  const update = (entry: AgentLogEntry) => {
    setEntries((list) => list?.map((e) => (e.id === entry.id ? entry : e)) ?? null);
    // the open evaluation keeps the rating it shows
    if (entry.id === openId) onOpen(entry);
  };
  const changeFilter = (next: Filter) => {
    setFilter(next);
    setLimit(PAGE);
  };

  const list = entries ?? [];
  const good = list.filter((e) => e.rating === "good").length;
  const bad = list.filter((e) => e.rating === "bad").length;
  const scored = good + bad;
  const avgMs = list.length ? list.reduce((sum, e) => sum + e.ms, 0) / list.length : null;
  const stats = [
    { label: t("Score"), value: scored ? `${Math.round((good / scored) * 100)}%` : "–" },
    { label: t("Questions"), value: String(list.length) },
    { label: t("To review"), value: String(list.length - scored) },
    { label: t("Good"), value: String(good) },
    { label: t("Bad"), value: String(bad) },
    { label: t("Average time"), value: avgMs === null ? "–" : t("{{seconds}} s", { seconds: (avgMs / 1000).toFixed(1) }) },
  ];

  const q = query.trim().toLowerCase();
  const shown = list.filter((e) => matches(e, filter) && (!q || e.question.toLowerCase().includes(q) || e.user.toLowerCase().includes(q)));

  const header = (
    <SectionHeader
      icon={<FactCheckOutlined />}
      title={t("Evaluations")}
      subtitle={t("Questions asked to the agent")}
      stats={entries ? stats : undefined}
      actions={
        <IconButton aria-label={t("Refresh")} onClick={() => void reload()}>
          <Refresh fontSize="small" />
        </IconButton>
      }
      tabs={FILTERS.map((f) => ({ value: f.id, label: `${t(f.label)} (${list.filter((e) => matches(e, f.id)).length})` }))}
      tab={filter}
      onTab={changeFilter}
    />
  );

  let body;
  if (entries === null) {
    body = (
      <Box sx={{ display: "flex", justifyContent: "center", pt: 8 }}>
        <CircularProgress size={22} />
      </Box>
    );
  } else if (list.length === 0) {
    body = (
      <Typography sx={{ color: "text.secondary", py: 8, textAlign: "center" }}>
        {t("No questions yet. Ask the agent something in the test chat.")}
      </Typography>
    );
  } else {
    body = (
      <>
        <Box sx={{ px: 3, py: 1.5, borderBottom: 1, borderColor: "divider" }}>
          <TextField
            fullWidth
            size="small"
            placeholder={t("Filter questions")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(PAGE);
            }}
            slotProps={{
              htmlInput: { "aria-label": t("Filter questions") },
              input: { startAdornment: <Search fontSize="small" sx={{ color: "text.disabled", mr: 1 }} /> },
            }}
          />
        </Box>
        {shown.length === 0 ? (
          <Typography sx={{ color: "text.secondary", py: 4, textAlign: "center" }}>{t("No questions here.")}</Typography>
        ) : (
          <>
            <EvalTable slug={slug} rows={shown.slice(0, limit)} openId={openId} onOpen={onOpen} onRated={update} />
            {shown.length > limit && (
              <Box sx={{ display: "flex", justifyContent: "center", py: 1.5 }}>
                <Button size="small" onClick={() => setLimit(limit + PAGE)}>
                  {t("Show more")}
                </Button>
              </Box>
            )}
          </>
        )}
      </>
    );
  }

  return <SectionLayout header={header}>{body}</SectionLayout>;
}
