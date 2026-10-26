"use client";

import SendRounded from "@mui/icons-material/SendRounded";
import StopRounded from "@mui/icons-material/StopRounded";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import type { Ref } from "react";

import { useTranslation } from "@/i18n";
import { MAX_MESSAGE } from "@/lib/iara/protocol";

/** The message field: Enter sends, Shift+Enter breaks the line, and the send button is a stop button while Iara works. */
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  locked,
  inputRef,
}: {
  value: string;
  onChange(value: string): void;
  onSend(text: string): void;
  onStop(): void;
  busy: boolean;
  /** a proposal waits for the user's answer */
  locked: boolean;
  inputRef?: Ref<HTMLTextAreaElement>;
}) {
  const { t } = useTranslation();
  const canSend = !busy && !locked && value.trim() !== "";
  const send = () => canSend && onSend(value);
  return (
    <Box sx={{ display: "flex", alignItems: "flex-end", gap: 0.5, p: 1.5, borderTop: 1, borderColor: "divider", flexShrink: 0 }}>
      <TextField
        multiline
        maxRows={6}
        fullWidth
        size="small"
        autoFocus
        value={value}
        disabled={locked}
        placeholder={locked ? t("Answer the proposal above first") : t("Ask Iara…")}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        inputRef={inputRef}
        slotProps={{ htmlInput: { maxLength: MAX_MESSAGE, "aria-label": t("Message to Iara") } }}
      />
      {busy ? (
        <IconButton aria-label={t("Stop")} onClick={onStop} color="secondary">
          <StopRounded />
        </IconButton>
      ) : (
        <IconButton aria-label={t("Send message")} onClick={send} disabled={!canSend} color="secondary">
          <SendRounded />
        </IconButton>
      )}
    </Box>
  );
}
