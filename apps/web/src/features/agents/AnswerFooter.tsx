"use client";

import ThumbDownAltOutlined from "@mui/icons-material/ThumbDownAltOutlined";
import ThumbUpAltOutlined from "@mui/icons-material/ThumbUpAltOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { useState } from "react";

import { useNotify } from "@/features/shell/notify";
import { useTranslation } from "@/i18n";
import type { AgentExample, AgentRating } from "@/lib/agents/types";
import type { IaraMessage } from "@/lib/iara/protocol";

import { AgentChart } from "./AgentChart";
import { rateEntry } from "./rateEntry";
import { SaveExampleButton } from "./SaveExampleButton";
import { SqlBlock } from "./SqlBlock";

/** Under a finished answer of the test chat: its charts, the SQL it ran (to keep as an example), and the rating of the answer. */
export function AnswerFooter({
  slug,
  message,
  question,
  examples,
  onAddExample,
}: {
  slug: string;
  message: IaraMessage;
  /** the user's message this answers */
  question: string;
  examples: AgentExample[];
  onAddExample(example: AgentExample): void;
}) {
  const { t } = useTranslation();
  const notify = useNotify();
  const [rating, setRating] = useState<AgentRating | null>(null);
  const [allQueries, setAllQueries] = useState(false);
  const queries = (message.steps ?? []).flatMap((s) => (s.kind === "tool" && s.tool === "run_sql" && s.sql ? [s.sql] : []));
  const shown = allQueries ? queries : queries.slice(-1);
  const saved = examples.some((e) => e.question === question);
  if (!queries.length && !message.text && !message.charts?.length) return null;

  const rate = async (next: AgentRating) => {
    const before = rating;
    const value = before === next ? null : next;
    setRating(value);
    const r = await rateEntry(slug, message.id, value);
    if (!r.ok) {
      setRating(before);
      notify(r.error.message, "error");
    }
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {message.charts?.map((chart) => (
        <AgentChart key={chart.id} chart={chart} />
      ))}
      {shown.map((sql, i) => (
        <SqlBlock key={i} sql={sql} maxHeight={240} actions={<SaveExampleButton saved={saved} onSave={() => onAddExample({ question, sql })} />} />
      ))}
      {queries.length > 1 && (
        <Button size="small" onClick={() => setAllQueries(!allQueries)} sx={{ alignSelf: "flex-start", fontSize: 11, py: 0 }}>
          {allQueries ? t("Show last query") : t("{{count}} queries", { count: queries.length })}
        </Button>
      )}
      {message.text && (
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, flexWrap: "wrap" }}>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {t("Did this answer follow your instructions?")}
          </Typography>
          <Box sx={{ display: "flex", gap: 0.5 }}>
            <Button
              size="small"
              color="success"
              variant={rating === "good" ? "contained" : "outlined"}
              aria-pressed={rating === "good"}
              startIcon={<ThumbUpAltOutlined />}
              onClick={() => void rate("good")}
              sx={{ fontSize: 11, py: 0 }}
            >
              {t("Accurate")}
            </Button>
            <Button
              size="small"
              color="error"
              variant={rating === "bad" ? "contained" : "outlined"}
              aria-pressed={rating === "bad"}
              startIcon={<ThumbDownAltOutlined />}
              onClick={() => void rate("bad")}
              sx={{ fontSize: 11, py: 0 }}
            >
              {t("Report")}
            </Button>
          </Box>
        </Box>
      )}
    </Box>
  );
}
