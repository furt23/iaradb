"use client";

import ArrowBack from "@mui/icons-material/ArrowBack";
import ThumbDownAlt from "@mui/icons-material/ThumbDownAlt";
import ThumbDownAltOutlined from "@mui/icons-material/ThumbDownAltOutlined";
import ThumbUpAlt from "@mui/icons-material/ThumbUpAlt";
import ThumbUpAltOutlined from "@mui/icons-material/ThumbUpAltOutlined";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useEffect, useState } from "react";

import { ChatMarkdown } from "@/features/iara/ChatMarkdown";
import { LocalTime } from "@/features/shell/LocalTime";
import { useNotify } from "@/features/shell/notify";
import { useTranslation } from "@/i18n";
import type { AgentExample, AgentLogEntry, AgentRating } from "@/lib/agents/types";

import { AgentChart } from "./AgentChart";
import { SaveExampleButton } from "./SaveExampleButton";
import { SqlBlock } from "./SqlBlock";
import { rateEntry } from "./rateEntry";

const OVERLINE = { color: "text.disabled", lineHeight: 1.6, display: "block" } as const;

/** One evaluated question, in the left panel: the answer with its charts and SQL, the rating and the note. */
export function EvaluationDetail({
  slug,
  entry,
  examples,
  onAddExample,
  onChange,
  onClose,
}: {
  slug: string;
  entry: AgentLogEntry;
  examples: AgentExample[];
  onAddExample(example: AgentExample): void;
  /** the entry as it was rated or noted */
  onChange(entry: AgentLogEntry): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const notify = useNotify();
  const [note, setNote] = useState(entry.note);
  // another question opened in place of this one
  useEffect(() => {
    setNote(entry.note);
  }, [entry.id]);

  const asked = examples.some((x) => x.question.trim() === entry.question.trim());

  // a rating keeps the note as it is on screen (a note not yet saved is saved by the blur before)
  const rate = async (rating: AgentRating | null) => {
    const r = await rateEntry(slug, entry.id, rating, note);
    if (r.ok) onChange(r.data);
    else notify(r.error.message, "error");
  };
  const saveNote = () => {
    if (note !== entry.note) void rate(entry.rating);
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1.5, height: 48, borderBottom: 1, borderColor: "divider", bgcolor: "background.paper", flexShrink: 0 }}>
        <IconButton size="small" aria-label={t("Back")} onClick={onClose}>
          <ArrowBack fontSize="small" />
        </IconButton>
        <Typography noWrap sx={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 13 }}>
          {t("Evaluation")}
        </Typography>
        <IconButton
          size="small"
          aria-label={t("Good answer")}
          aria-pressed={entry.rating === "good"}
          onClick={() => void rate(entry.rating === "good" ? null : "good")}
          sx={{ color: entry.rating === "good" ? "success.main" : "text.secondary" }}
        >
          {entry.rating === "good" ? <ThumbUpAlt fontSize="small" /> : <ThumbUpAltOutlined fontSize="small" />}
        </IconButton>
        <IconButton
          size="small"
          aria-label={t("Bad answer")}
          aria-pressed={entry.rating === "bad"}
          onClick={() => void rate(entry.rating === "bad" ? null : "bad")}
          sx={{ color: entry.rating === "bad" ? "error.main" : "text.secondary" }}
        >
          {entry.rating === "bad" ? <ThumbDownAlt fontSize="small" /> : <ThumbDownAltOutlined fontSize="small" />}
        </IconButton>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", px: 2, py: 2, display: "flex", flexDirection: "column", gap: 2 }}>
        <Box sx={{ alignSelf: "flex-end", maxWidth: "85%", px: 1.5, py: 1, borderRadius: 2, bgcolor: "action.hover", fontSize: 14, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {entry.question}
        </Box>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {entry.user ? `${entry.user} · ` : ""}
          <LocalTime ms={entry.at} /> · {t("{{seconds}} s", { seconds: (entry.ms / 1000).toFixed(1) })}
        </Typography>
        {entry.answer && <ChatMarkdown text={entry.answer} />}
        {entry.charts?.map((chart) => (
          <AgentChart key={chart.id} chart={chart} />
        ))}
        {entry.queries.length > 0 && (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <Typography variant="overline" sx={OVERLINE}>
              {t("SQL ({{count}})", { count: entry.queries.length })}
            </Typography>
            {entry.queries.map((sql, i) => (
              <SqlBlock key={i} sql={sql} maxHeight={240} actions={<SaveExampleButton saved={asked} onSave={() => onAddExample({ question: entry.question, sql })} />} />
            ))}
          </Box>
        )}
        <Box>
          <Typography variant="overline" sx={OVERLINE}>
            {t("Note")}
          </Typography>
          <TextField
            fullWidth
            multiline
            minRows={2}
            size="small"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={saveNote}
            slotProps={{ htmlInput: { "aria-label": t("Note") } }}
          />
        </Box>
      </Box>
    </Box>
  );
}
