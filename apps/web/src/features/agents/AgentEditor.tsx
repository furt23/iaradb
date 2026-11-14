"use client";

import ArrowBack from "@mui/icons-material/ArrowBack";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useTranslation } from "@/i18n";
import type { Agent, AgentConfig, AgentExample, AgentLogEntry } from "@/lib/agents/types";
import { saveAgentConfigAction, saveExamplesAction, saveInstructionsAction } from "@/server/actions/agents";

import { AgentPlayground } from "./AgentPlayground";
import { AgentRail, type AgentSection } from "./AgentRail";
import { EvalsTab } from "./EvalsTab";
import { EvaluationDetail } from "./EvaluationDetail";
import { ExamplesTab } from "./ExamplesTab";
import { InstructionsTab } from "./InstructionsTab";
import { TablesTab } from "./TablesTab";
import { useAutosave, type SaveStatus } from "./useAutosave";

const TITLE_MAX = 120;
const DESCRIPTION_MAX = 1000;

/** The agent's studio: a header, the sections (rail and panel) on the left, the test playground on the right. Edits autosave. */
export function AgentEditor({ slug, opened }: { slug: string; opened: Agent }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [config, setConfig] = useState<AgentConfig>(opened.config);
  const [instructions, setInstructions] = useState(opened.instructions);
  const [examples, setExamples] = useState<AgentExample[]>(opened.examples);
  const [section, setSection] = useState<AgentSection>("instructions");
  // an evaluation opened from the Evaluations section, shown where the playground is
  const [evaluation, setEvaluation] = useState<AgentLogEntry | null>(null);

  const configSave = useAutosave<AgentConfig>((next) => saveAgentConfigAction(slug, next));
  const instructionsSave = useAutosave<string>((text) => saveInstructionsAction(slug, text));
  const examplesSave = useAutosave<AgentExample[]>((list) => saveExamplesAction(slug, list));

  const changeConfig = (next: AgentConfig) => {
    setConfig(next);
    // the server refuses a blank name or term: wait until they are written
    if (next.title.trim() && next.glossary.every((g) => g.term.trim())) configSave.schedule(next);
  };
  const changeInstructions = (text: string) => {
    setInstructions(text);
    instructionsSave.schedule(text);
  };
  const changeExamples = (next: AgentExample[]) => {
    setExamples(next);
    if (next.every((e) => e.question.trim() !== "")) examplesSave.schedule(next);
  };
  const addExample = (example: AgentExample) => changeExamples([...examples, example]);

  const flushAll = async () => {
    await Promise.all([configSave.flush(), instructionsSave.flush(), examplesSave.flush()]);
  };
  const changeSection = (next: AgentSection) => {
    void flushAll();
    setSection(next);
    if (next !== "evals") setEvaluation(null);
  };

  const statuses: SaveStatus[] = [configSave.status, instructionsSave.status, examplesSave.status];
  const status: SaveStatus = statuses.includes("error") ? "error" : statuses.includes("saving") ? "saving" : "saved";

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 2, py: 1, borderBottom: 1, borderColor: "divider", bgcolor: "background.paper", flexShrink: 0 }}>
        <IconButton size="small" aria-label={t("All agents")} onClick={() => router.push("/agents")}>
          <ArrowBack fontSize="small" />
        </IconButton>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <TextField
              variant="standard"
              value={config.title}
              onChange={(e) => changeConfig({ ...config, title: e.target.value })}
              slotProps={{ htmlInput: { "aria-label": t("Name"), maxLength: TITLE_MAX }, input: { disableUnderline: true, sx: { fontSize: 17, fontWeight: 650 } } }}
              sx={{ flex: 1, minWidth: 0 }}
            />
            <Chip
              size="small"
              variant="outlined"
              color={status === "error" ? "error" : status === "saving" ? "warning" : "success"}
              label={status === "error" ? t("Not saved") : status === "saving" ? t("Saving") : t("Saved")}
              sx={{ height: 20, fontSize: 11 }}
            />
          </Box>
          <TextField
            variant="standard"
            fullWidth
            placeholder={t("What this agent is for")}
            value={config.description}
            onChange={(e) => changeConfig({ ...config, description: e.target.value })}
            slotProps={{ htmlInput: { "aria-label": t("Description"), maxLength: DESCRIPTION_MAX }, input: { disableUnderline: true, sx: { fontSize: 12, color: "text.secondary" } } }}
          />
        </Box>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: { xs: "column-reverse", lg: "row" } }}>
        <Box
          sx={{
            width: { xs: "100%", lg: 420, xl: 480 },
            flexShrink: 0,
            height: { xs: "50%", lg: "100%" },
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            borderRight: { lg: 1 },
            borderTop: { xs: 1, lg: 0 },
            borderColor: "divider",
          }}
        >
          {/* the playground stays mounted under an open evaluation, so its conversation survives */}
          <Box sx={{ display: evaluation ? "none" : "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
            <AgentPlayground slug={slug} examples={examples} beforeSend={flushAll} onAddExample={addExample} />
          </Box>
          {evaluation && (
            <EvaluationDetail
              slug={slug}
              entry={evaluation}
              examples={examples}
              onAddExample={addExample}
              onChange={setEvaluation}
              onClose={() => setEvaluation(null)}
            />
          )}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0, height: { xs: "50%", lg: "100%" }, display: "flex", minHeight: 0 }}>
          <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" }}>
            {section === "instructions" && (
              <InstructionsTab
                value={instructions}
                onChange={changeInstructions}
                glossary={config.glossary}
                onGlossary={(glossary) => changeConfig({ ...config, glossary })}
                style={config.style}
                onStyle={(style) => changeConfig({ ...config, style })}
              />
            )}
            {section === "tables" && <TablesTab tables={config.tables} onChange={(tables) => changeConfig({ ...config, tables })} />}
            {section === "examples" && <ExamplesTab slug={slug} examples={examples} onChange={changeExamples} />}
            {section === "evals" && <EvalsTab slug={slug} openId={evaluation?.id ?? null} changed={evaluation} onOpen={setEvaluation} />}
          </Box>
          <AgentRail
            value={section}
            onChange={changeSection}
            counts={{ tables: config.tables.filter((x) => x.included).length, examples: examples.length }}
          />
        </Box>
      </Box>
    </Box>
  );
}
