"use client";

import Add from "@mui/icons-material/Add";
import DescriptionOutlined from "@mui/icons-material/DescriptionOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import { useState } from "react";

import { useTranslation } from "@/i18n";
import { MAX_INSTRUCTIONS, MAX_TERMS } from "@/lib/agents/check";
import type { AgentStyle, AgentTerm } from "@/lib/agents/types";

import { AgentGlossary } from "./AgentGlossary";
import { AgentStyleForm } from "./AgentStyleForm";
import { SectionHeader, SectionLayout } from "./AgentSection";

type TabId = "instructions" | "glossary" | "style";

/** How the agent works and answers: its instructions, the terms it knows, and how its answers read. */
export function InstructionsTab({
  value,
  onChange,
  glossary,
  onGlossary,
  style,
  onStyle,
}: {
  value: string;
  onChange(v: string): void;
  glossary: AgentTerm[];
  onGlossary(g: AgentTerm[]): void;
  style: AgentStyle;
  onStyle(s: AgentStyle): void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabId>("instructions");
  const over = value.length > MAX_INSTRUCTIONS;
  const tabs: { value: TabId; label: string }[] = [
    { value: "instructions", label: t("Instructions") },
    { value: "glossary", label: t("Glossary ({{count}})", { count: glossary.length }) },
    { value: "style", label: t("Answer style") },
  ];

  const header = (
    <SectionHeader<TabId>
      icon={<DescriptionOutlined />}
      title={t("Instructions")}
      subtitle={t("How the agent works and answers")}
      stats={[
        { label: t("Characters"), value: `${value.length} / ${MAX_INSTRUCTIONS}` },
        { label: t("Terms"), value: String(glossary.length) },
      ]}
      actions={
        tab === "glossary" ? (
          <Button
            variant="text"
            size="small"
            startIcon={<Add />}
            disabled={glossary.length >= MAX_TERMS}
            onClick={() => onGlossary([...glossary, { term: "", definition: "" }])}
          >
            {t("Add term")}
          </Button>
        ) : undefined
      }
      tabs={tabs}
      tab={tab}
      onTab={setTab}
    />
  );

  return (
    <SectionLayout header={header}>
      {tab === "instructions" && (
        <Box sx={{ height: "100%", minHeight: 320 }}>
          <TextField
            multiline
            fullWidth
            variant="standard"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            error={over}
            helperText={over ? t("Over the limit of {{max}} characters", { max: MAX_INSTRUCTIONS }) : undefined}
            placeholder={t(
              "You answer questions about sales for the regions in the tables.\nUse only the listed tables. Give the total first, then the detail.\nSay so when the data does not answer the question. Keep answers short and in English.",
            )}
            sx={{ height: "100%" }}
            slotProps={{
              htmlInput: { "aria-label": t("Instructions"), style: { height: "100%" } },
              input: {
                disableUnderline: true,
                sx: { height: "100%", alignItems: "stretch", px: 3, py: 2, fontFamily: "monospace", fontSize: 13, lineHeight: 1.6 },
              },
            }}
          />
        </Box>
      )}
      {tab === "glossary" && <AgentGlossary glossary={glossary} onGlossary={onGlossary} />}
      {tab === "style" && <AgentStyleForm style={style} onStyle={onStyle} />}
    </SectionLayout>
  );
}
