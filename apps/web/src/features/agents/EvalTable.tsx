"use client";

import ThumbDownAlt from "@mui/icons-material/ThumbDownAlt";
import ThumbDownAltOutlined from "@mui/icons-material/ThumbDownAltOutlined";
import ThumbUpAlt from "@mui/icons-material/ThumbUpAlt";
import ThumbUpAltOutlined from "@mui/icons-material/ThumbUpAltOutlined";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";

import { LocalTime } from "@/features/shell/LocalTime";
import { useNotify } from "@/features/shell/notify";
import { useTranslation } from "@/i18n";
import type { AgentLogEntry, AgentRating } from "@/lib/agents/types";

import { rateEntry } from "./rateEntry";

const HEAD = { fontSize: 12, color: "text.secondary", whiteSpace: "nowrap", bgcolor: "background.paper" } as const;

/** One question: its status and who asked it; a click opens it, the thumbs rate it in place. */
function Row({
  slug,
  entry,
  selected,
  onOpen,
  onRated,
}: {
  slug: string;
  entry: AgentLogEntry;
  selected: boolean;
  onOpen(): void;
  onRated(entry: AgentLogEntry): void;
}) {
  const { t } = useTranslation();
  const notify = useNotify();

  // a second click on the same rating clears it
  const rate = async (rating: AgentRating) => {
    const r = await rateEntry(slug, entry.id, entry.rating === rating ? null : rating, entry.note);
    if (r.ok) onRated(r.data);
    else notify(r.error.message, "error");
  };

  const tone = entry.rating === "good" ? "success.main" : entry.rating === "bad" ? "error.main" : "text.disabled";
  const word = entry.rating === "good" ? t("Good") : entry.rating === "bad" ? t("Bad") : t("To review");

  return (
    <TableRow
      hover
      selected={selected}
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
      sx={{ height: 40, cursor: "pointer" }}
    >
      <TableCell sx={{ whiteSpace: "nowrap", width: 120 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: tone, flexShrink: 0 }} />
          <Typography sx={{ fontSize: 13, color: entry.rating ? "text.primary" : "text.disabled" }}>{word}</Typography>
        </Box>
      </TableCell>
      <TableCell sx={{ width: "100%", maxWidth: 0 }}>
        <Typography noWrap sx={{ fontSize: 13 }}>
          {entry.question}
        </Typography>
      </TableCell>
      <TableCell sx={{ maxWidth: 180 }}>
        <Typography noWrap sx={{ fontSize: 13, color: "text.secondary" }}>
          {entry.user || "–"}
        </Typography>
      </TableCell>
      <TableCell sx={{ whiteSpace: "nowrap" }}>
        <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
          <LocalTime ms={entry.at} />
        </Typography>
      </TableCell>
      <TableCell align="right" sx={{ whiteSpace: "nowrap", fontFamily: "monospace", fontSize: 12, color: "text.secondary" }}>
        {t("{{seconds}} s", { seconds: (entry.ms / 1000).toFixed(1) })}
      </TableCell>
      <TableCell align="right" sx={{ whiteSpace: "nowrap", width: 84 }}>
        <IconButton
          size="small"
          aria-label={t("Good answer")}
          aria-pressed={entry.rating === "good"}
          onClick={(e) => {
            e.stopPropagation();
            void rate("good");
          }}
          sx={{ color: entry.rating === "good" ? "success.main" : "text.secondary" }}
        >
          {entry.rating === "good" ? <ThumbUpAlt fontSize="small" /> : <ThumbUpAltOutlined fontSize="small" />}
        </IconButton>
        <IconButton
          size="small"
          aria-label={t("Bad answer")}
          aria-pressed={entry.rating === "bad"}
          onClick={(e) => {
            e.stopPropagation();
            void rate("bad");
          }}
          sx={{ color: entry.rating === "bad" ? "error.main" : "text.secondary" }}
        >
          {entry.rating === "bad" ? <ThumbDownAlt fontSize="small" /> : <ThumbDownAltOutlined fontSize="small" />}
        </IconButton>
      </TableCell>
    </TableRow>
  );
}

/** The questions as a flat table; the row open on the left is marked. */
export function EvalTable({
  slug,
  rows,
  openId,
  onOpen,
  onRated,
}: {
  slug: string;
  rows: AgentLogEntry[];
  openId: string | null;
  onOpen(entry: AgentLogEntry): void;
  /** a row's rating was saved */
  onRated(entry: AgentLogEntry): void;
}) {
  const { t } = useTranslation();
  return (
    <Table size="small" stickyHeader aria-label={t("Evaluations")}>
      <TableHead>
        <TableRow>
          <TableCell sx={HEAD}>{t("Status")}</TableCell>
          <TableCell sx={HEAD}>{t("Question")}</TableCell>
          <TableCell sx={HEAD}>{t("Asked by")}</TableCell>
          <TableCell sx={HEAD}>{t("When")}</TableCell>
          <TableCell sx={HEAD} align="right">
            {t("Time")}
          </TableCell>
          <TableCell sx={HEAD} />
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((entry) => (
          <Row
            key={entry.id}
            slug={slug}
            entry={entry}
            selected={entry.id === openId}
            onOpen={() => onOpen(entry)}
            onRated={onRated}
          />
        ))}
      </TableBody>
    </Table>
  );
}
