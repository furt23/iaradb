"use client";

import Close from "@mui/icons-material/Close";
import MoreVert from "@mui/icons-material/MoreVert";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Typography from "@mui/material/Typography";
import { IaraMark } from "@iara/ui";
import { useRef, useState } from "react";

import { useTranslation } from "@/i18n";
import type { IaraFileContext, IaraSurface } from "@/lib/iara/protocol";

import { Composer } from "./Composer";
import { HistoryView } from "./HistoryView";
import { MemoriesView } from "./MemoriesView";
import { MessageList } from "./MessageList";
import { TokenMeter } from "./TokenMeter";
import type { IaraAdapter } from "./types";
import { useIaraChat } from "./useIaraChat";

type View = "chat" | "history" | "memories";

/** Iara, the chat agent, in a panel on the right of a notebook or of the SQL editor. */
export function IaraPanel({
  fileId,
  surface,
  getContext,
  adapter,
  onClose,
}: {
  fileId: string;
  surface: IaraSurface;
  /** the file as it is now, read at each message and decision */
  getContext: () => IaraFileContext;
  adapter: IaraAdapter;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const chat = useIaraChat({ fileId, surface, getContext, adapter });
  const { thread } = chat;
  const [view, setView] = useState<View>("chat");
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);

  const go = (next: View) => () => {
    setMenu(null);
    setView(next);
  };

  return (
    <Box
      component="aside"
      aria-label="Iara"
      sx={{ width: 380, flexShrink: 0, height: "100%", display: "flex", flexDirection: "column", borderLeft: 1, borderColor: "divider", bgcolor: "background.paper", minHeight: 0 }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1.5, height: 48, borderBottom: 1, borderColor: "divider", flexShrink: 0 }}>
        <IaraMark thinking={chat.busy} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography noWrap sx={{ fontWeight: 650, fontSize: 14, lineHeight: 1.2 }}>
            Iara
          </Typography>
          <Typography noWrap variant="caption" sx={{ display: "block", color: "text.secondary", lineHeight: 1.2 }}>
            {thread?.title || t("New conversation")}
          </Typography>
        </Box>
        {thread && thread.usage.budget > 0 && <TokenMeter usage={thread.usage} />}
        <IconButton size="small" aria-label={t("Iara menu")} onClick={(e) => setMenu(e.currentTarget)}>
          <MoreVert fontSize="small" />
        </IconButton>
        <IconButton size="small" aria-label={t("Close")} onClick={onClose}>
          <Close fontSize="small" />
        </IconButton>
        <Menu anchorEl={menu} open={menu !== null} onClose={() => setMenu(null)}>
          <MenuItem
            onClick={() => {
              chat.newThread();
              go("chat")();
            }}
          >
            {t("New conversation")}
          </MenuItem>
          <MenuItem onClick={go("history")}>{t("History")}</MenuItem>
          <MenuItem onClick={go("memories")}>{t("Memories")}</MenuItem>
        </Menu>
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
      {view === "memories" && <MemoriesView onBack={() => setView("chat")} />}
      {view === "chat" && (
        <>
          <MessageList
            chat={chat}
            surface={surface}
            getContext={getContext}
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
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={(text) => {
              setDraft("");
              void chat.send(text);
            }}
            onStop={chat.stop}
            busy={chat.busy}
            locked={!!thread?.pending}
            inputRef={input}
          />
        </>
      )}
    </Box>
  );
}
