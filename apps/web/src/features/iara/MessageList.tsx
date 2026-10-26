"use client";

import Block from "@mui/icons-material/Block";
import CheckCircleOutlined from "@mui/icons-material/CheckCircleOutlined";
import ErrorOutlined from "@mui/icons-material/ErrorOutlined";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Typography from "@mui/material/Typography";
import { useLayoutEffect, useRef } from "react";

import { useTranslation } from "@/i18n";
import type { IaraFileContext, IaraMessage, IaraProposalRecord, IaraSurface } from "@/lib/iara/protocol";

import { ApprovalCard } from "./ApprovalCard";
import { ChatMarkdown } from "./ChatMarkdown";
import { EmptyState } from "./EmptyState";
import { AGENT_LABEL, changeTitle, recordStatus } from "./labels";
import { StepTimeline } from "./StepTimeline";
import type { IaraChat } from "./useIaraChat";

const TONE_COLOR = { ok: "success.main", error: "error.main", muted: "text.secondary" } as const;

/** What became of a proposal the user already answered, on one line. */
function ProposalRecord({ proposal }: { proposal: IaraProposalRecord }) {
  const { t } = useTranslation();
  const { label, tone } = recordStatus(proposal);
  const title = changeTitle(proposal.change);
  const Icon = tone === "ok" ? CheckCircleOutlined : tone === "error" ? ErrorOutlined : Block;
  const error = proposal.outcome?.error;
  return (
    <Box sx={{ color: TONE_COLOR[tone] }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
        <Icon sx={{ fontSize: 16 }} />
        <Typography variant="body2" sx={{ color: "inherit", fontWeight: 600 }}>
          {t(label.key)}
        </Typography>
        <Typography variant="body2" noWrap sx={{ color: "text.secondary", minWidth: 0 }}>
          · {t(title.key, title.values)}
        </Typography>
      </Box>
      {error && (
        <Typography variant="caption" sx={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", color: "text.secondary", ml: 2.75 }}>
          {error}
        </Typography>
      )}
    </Box>
  );
}

/** Iara's message: her steps above the text, then what she remembered and the proposals. */
function IaraBubble({ message, chat, getContext, isLast }: { message: IaraMessage; chat: IaraChat; getContext: () => IaraFileContext; isLast: boolean }) {
  const { t } = useTranslation();
  const { steps, memories, proposals } = message;
  if (!message.text && !steps?.length && !memories?.length && !proposals?.length) return null;
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {!!steps?.length && <StepTimeline steps={steps} live={chat.busy && isLast} agent={chat.agent} />}
      {message.text && <ChatMarkdown text={message.text} />}
      {!!memories?.length && (
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
          {memories.map((m, i) => (
            <Chip
              key={`m${i}`}
              size="small"
              variant="outlined"
              label={m.action === "saved" ? t("Saved to memory: {{text}}", { text: m.memory.text }) : t("Forgot: {{text}}", { text: m.memory.text })}
              sx={{ maxWidth: "100%" }}
            />
          ))}
        </Box>
      )}
      {proposals?.map((p) =>
        p.decision === "pending" ? (
          <ApprovalCard
            key={p.id}
            proposal={p}
            busy={chat.busy}
            canRun={chat.canRun}
            getContext={getContext}
            onApprove={(run) => void chat.approve(run)}
            onReject={(feedback) => void chat.reject(feedback)}
          />
        ) : (
          <ProposalRecord key={p.id} proposal={p} />
        ),
      )}
    </Box>
  );
}

/**
 * The conversation: the user's messages in bubbles on the right, Iara's as
 * markdown with her steps and proposals. It follows new content to the
 * bottom unless the user scrolled up; a new message follows regardless.
 */
export function MessageList({ chat, surface, getContext, onPick }: { chat: IaraChat; surface: IaraSurface; getContext: () => IaraFileContext; onPick(text: string): void }) {
  const { t } = useTranslation();
  const { thread, busy, agent } = chat;
  const messages = thread?.messages ?? [];
  const box = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const seen = useRef(0);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (messages.length !== seen.current) {
      seen.current = messages.length;
      follow.current = true;
    }
    if (follow.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <Box
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
      sx={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2, p: 1.5 }}
    >
      {messages.length === 0 ? (
        <EmptyState surface={surface} onPick={onPick} />
      ) : (
        messages.map((m, i) =>
          m.role === "user" ? (
            <Box key={m.id} sx={{ alignSelf: "flex-end", maxWidth: "85%", px: 1.5, py: 1, borderRadius: 2, bgcolor: "action.hover", fontSize: 14, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {m.text}
            </Box>
          ) : (
            <IaraBubble key={m.id} message={m} chat={chat} getContext={getContext} isLast={i === messages.length - 1} />
          ),
        )
      )}
      {/* the timeline's header names the agent while a message has steps */}
      {busy && !thread?.pending && !messages.at(-1)?.steps?.length && (
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {t(AGENT_LABEL[agent ?? "iara"])}…
        </Typography>
      )}
    </Box>
  );
}
