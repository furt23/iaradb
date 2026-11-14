"use client";

import HistoryRounded from "@mui/icons-material/HistoryRounded";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import { useCallback, useRef, useState } from "react";

import { Composer } from "@/features/iara/Composer";
import { HistoryView } from "@/features/iara/HistoryView";
import { MessageList } from "@/features/iara/MessageList";
import { useIaraChat } from "@/features/iara/useIaraChat";
import { useTranslation } from "@/i18n";
import type { AgentExample } from "@/lib/agents/types";

import { agentContext, NO_CHANGES } from "./agentChat";
import { AnswerFooter } from "./AnswerFooter";

const MAX_CHIPS = 6;
const CHIP_CHARS = 40;

const short = (question: string) => (question.length > CHIP_CHARS ? `${question.slice(0, CHIP_CHARS - 1)}…` : question);

/** The agent's test chat, on the right of the studio: ask it anything, and keep its answers' SQL as examples. */
export function AgentPlayground({
  slug,
  examples,
  beforeSend,
  onAddExample,
}: {
  slug: string;
  examples: AgentExample[];
  /** saves the pending edits, so the server reads them */
  beforeSend(): Promise<void>;
  onAddExample(example: AgentExample): void;
}) {
  const { t } = useTranslation();
  const fileId = `agent:${slug}`;
  const getContext = useCallback(() => agentContext(slug), [slug]);
  const chat = useIaraChat({ fileId, surface: "agent", getContext, adapter: { ...NO_CHANGES, beforeSend } });
  const { thread } = chat;
  const locked = !!thread?.pending;
  const [view, setView] = useState<"chat" | "history">("chat");
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const chips = examples.slice(0, MAX_CHIPS);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1.5, height: 48, borderBottom: 1, borderColor: "divider", bgcolor: "background.paper", flexShrink: 0 }}>
        <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: "success.main", flexShrink: 0 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography noWrap sx={{ fontWeight: 600, fontSize: 13, lineHeight: 1.2 }}>
            {t("Test playground")}
          </Typography>
          {thread?.title && (
            <Typography noWrap variant="caption" sx={{ display: "block", color: "text.secondary", lineHeight: 1.2 }}>
              {thread.title}
            </Typography>
          )}
        </Box>
        <Button size="small" onClick={chat.newThread} sx={{ fontSize: 11, flexShrink: 0 }}>
          {t("Clear conversation")}
        </Button>
        <IconButton size="small" aria-label={t("History")} onClick={() => setView("history")}>
          <HistoryRounded fontSize="small" />
        </IconButton>
      </Box>
      {view === "history" && (
        <HistoryView
          fileId={fileId}
          currentId={thread?.id}
          onOpen={(id) => {
            void chat.openThread(id);
            setView("chat");
          }}
          onDeleted={(id) => id === thread?.id && chat.newThread()}
          onBack={() => setView("chat")}
        />
      )}
      {view === "chat" && (
        <>
          <MessageList
            chat={chat}
            surface="agent"
            suggestions={examples.map((e) => e.question)}
            getContext={getContext}
            footer={(message, question) => (
              <AnswerFooter slug={slug} message={message} question={question} examples={examples} onAddExample={onAddExample} />
            )}
            onPick={(text) => {
              setDraft(text);
              input.current?.focus();
            }}
          />
          {chat.error && (
            <Alert severity="error" sx={{ mx: 1.5, mb: 1, flexShrink: 0 }}>
              {t(chat.error)}
            </Alert>
          )}
          <Box sx={{ borderTop: 1, borderColor: "divider", bgcolor: "background.paper", flexShrink: 0 }}>
            {chips.length > 0 && (
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0, px: 1.5, pt: 1.25 }}>
                <Typography sx={{ flexShrink: 0, fontSize: 10, fontWeight: 600, textTransform: "uppercase", color: "text.secondary" }}>
                  {t("Try")}
                </Typography>
                <Box sx={{ display: "flex", gap: 0.75, minWidth: 0, overflowX: "auto", pb: 0.5 }}>
                  {chips.map((e, i) => (
                    <Chip
                      key={i}
                      size="small"
                      variant="outlined"
                      label={short(e.question)}
                      title={e.question}
                      disabled={chat.busy || locked}
                      onClick={() => void chat.send(e.question)}
                      sx={{ flexShrink: 0 }}
                    />
                  ))}
                </Box>
              </Box>
            )}
            <Composer
              value={draft}
              onChange={setDraft}
              onSend={(text) => {
                setDraft("");
                void chat.send(text);
              }}
              onStop={chat.stop}
              busy={chat.busy}
              locked={locked}
              inputRef={input}
            />
          </Box>
        </>
      )}
    </Box>
  );
}
