"use client";

import Box from "@mui/material/Box";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";

import { useTranslation } from "@/i18n";
import type { AgentStyle } from "@/lib/agents/types";

const TONE_MAX = 500;

/** One setting: its label and caption on the left, its control on the right. */
function Row({ label, caption, children }: { label: string; caption: string; children: ReactNode }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 2, px: 3, py: 1.5, borderBottom: 1, borderColor: "divider" }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{label}</Typography>
        <Typography variant="caption" sx={{ display: "block", color: "text.secondary" }}>
          {caption}
        </Typography>
      </Box>
      {children}
    </Box>
  );
}

/** A select in a row: a value from a fixed list. */
function Pick<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange(v: T): void }) {
  return (
    <TextField
      select
      size="small"
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      sx={{ width: 240, flexShrink: 0 }}
      slotProps={{ select: { inputProps: { "aria-label": label } }, input: { sx: { fontSize: 13 } } }}
    >
      {options.map((o) => (
        <MenuItem key={o.value} value={o.value}>
          {o.label}
        </MenuItem>
      ))}
    </TextField>
  );
}

/** How the agent's answers read: language, length, charts and tone. */
export function AgentStyleForm({ style, onStyle }: { style: AgentStyle; onStyle(s: AgentStyle): void }) {
  const { t } = useTranslation();
  const set = (next: Partial<AgentStyle>) => onStyle({ ...style, ...next });

  return (
    <Box>
      <Row label={t("Language")} caption={t("The language of the answers")}>
        <Pick
          label={t("Language")}
          value={style.language}
          onChange={(language) => set({ language })}
          options={[
            { value: "auto", label: t("Same as the question") },
            { value: "pt", label: t("Portuguese") },
            { value: "en", label: t("English") },
          ]}
        />
      </Row>
      <Row label={t("Length")} caption={t("How long the answers run")}>
        <Pick
          label={t("Length")}
          value={style.length}
          onChange={(length) => set({ length })}
          options={[
            { value: "short", label: t("Short") },
            { value: "balanced", label: t("Balanced") },
            { value: "detailed", label: t("Detailed") },
          ]}
        />
      </Row>
      <Row label={t("Charts")} caption={t("When the agent draws a chart")}>
        <Pick
          label={t("Charts")}
          value={style.charts}
          onChange={(charts) => set({ charts })}
          options={[
            { value: "auto", label: t("When they help") },
            { value: "often", label: t("Whenever possible") },
            { value: "never", label: t("Never") },
          ]}
        />
      </Row>
      <Row label={t("Tone")} caption={t("The voice of the answers")}>
        <TextField
          size="small"
          value={style.tone}
          placeholder={t("Formal, for executives, friendly…")}
          onChange={(e) => set({ tone: e.target.value })}
          sx={{ width: 240, flexShrink: 0 }}
          slotProps={{ htmlInput: { "aria-label": t("Tone"), maxLength: TONE_MAX }, input: { sx: { fontSize: 13 } } }}
        />
      </Row>
    </Box>
  );
}
