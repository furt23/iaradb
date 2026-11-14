import "server-only";

import type { Agent, AgentStyle, AgentTable } from "@/lib/agents/types";

import { canRead } from "../governance/grants";
import { cutToTokens } from "../iara/tokens";

/** tokens of the agent's definition in each prompt */
const BRIEF_TOKENS = 12_000;

/** What the agent may read for this user: its included tables, of those the user may read (userAllow null: unchecked). Never wider than either. */
export function agentAllow(userAllow: string[] | null, agent: Agent): string[] {
  return agent.config.tables
    .filter((t) => t.included)
    .map((t) => t.name)
    .filter((name) => canRead(userAllow, name));
}

function tableText(t: AgentTable): string {
  const columns = Object.entries(t.columns)
    .filter(([, note]) => note.trim())
    .map(([column, note]) => `\n  - ${column}: ${note.trim()}`)
    .join("");
  return `- ${t.name}${t.note.trim() ? `: ${t.note.trim()}` : ""}${columns}`;
}

const LANGUAGE = { auto: "the language of the question", pt: "Brazilian Portuguese", en: "English" } as const;
const LENGTH = { short: "short: the answer and its key numbers, no more", balanced: "the answer first, then the detail that explains it", detailed: "detailed: the answer, how it was computed and what stands out" } as const;
const CHARTS = {
  auto: "Draw a chart (show_chart) when a comparison, ranking or trend reads better as a picture.",
  often: "Draw a chart (show_chart) whenever the answer has several categories or a time series.",
  never: "",
} as const;

/** How the agent's answers read, as prompt lines. */
export function styleText({ language, length, charts, tone }: AgentStyle): string {
  return [`Answer in ${LANGUAGE[language]}. Length: ${LENGTH[length]}.`, tone.trim() && `Tone: ${tone.trim()}.`, CHARTS[charts]].filter(Boolean).join("\n");
}

/** The agent's definition as prompt text, for iara and the analyst alike: its author's instructions bind both. */
export function agentBrief(agent: Agent, allow: string[]): Promise<string> {
  const { title, description, tables, glossary } = agent.config;
  const readable = tables.filter((t) => allow.includes(t.name));
  const tablesText = readable.length ? readable.map(tableText).join("\n") : "(none: there is no data this agent may read for this user)";
  const terms = glossary.map((g) => `- ${g.term}: ${g.definition.trim()}`).join("\n");
  const examples = agent.examples.map((e) => `Question: ${e.question}${e.sql.trim() ? `\nSQL:\n${e.sql.trim()}` : ""}`).join("\n\n");
  return cutToTokens(
    [
      `Agent "${title}"${description.trim() ? `: ${description.trim()}` : ""}`,
      agent.instructions.trim() && `Its author's instructions (follow them):\n${agent.instructions.trim()}`,
      `How its answers read:\n${styleText(agent.config.style)}`,
      terms && `Its business terms (use these meanings):\n${terms}`,
      `The only tables it may read, with what their columns mean:\n${tablesText}`,
      examples && `Questions it should answer, with the SQL that answers them (reuse and adapt this SQL when a question matches one):\n${examples}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    BRIEF_TOKENS,
  );
}
