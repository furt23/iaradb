import type { IaraChart } from "@/lib/iara/protocol";

/**
 * Agents: a focused Iara for one subject, made in the Studio. The definition
 * lives in the workspace (`agents/<slug>/`, versioned with it); the questions
 * people ask it are logged outside the workspace, for review.
 */

/** A table the agent knows, with what people should know about it. Only included tables are read (no other). */
export interface AgentTable {
  /** catalog.schema.table, as the catalog gives it */
  name: string;
  /** false: left out of the agent, its notes kept */
  included: boolean;
  /** what the table holds and how to use it */
  note: string;
  /** what a column means, by column name */
  columns: Record<string, string>;
}

/** A business term of the agent (its own: never written to a team's ontology). */
export interface AgentTerm {
  term: string;
  definition: string;
}

/** A question the agent should answer, with the SQL that answers it. */
export interface AgentExample {
  question: string;
  /** empty: a question with no query yet */
  sql: string;
}

/** How the agent's answers read. */
export interface AgentStyle {
  /** auto: the language of the question */
  language: "auto" | "pt" | "en";
  length: "short" | "balanced" | "detailed";
  /** auto: when a picture reads better; often: whenever the data allows; never: no charts */
  charts: "auto" | "often" | "never";
  /** free words on the tone (formal, friendly, for executives ...) */
  tone: string;
}

/** `agent.json` */
export interface AgentConfig {
  /** 8 random characters, fixed for the agent's life (the log is kept by it) */
  id: string;
  title: string;
  description: string;
  tables: AgentTable[];
  glossary: AgentTerm[];
  style: AgentStyle;
}

export interface Agent {
  slug: string;
  config: AgentConfig;
  /** `instructions.md`: how the agent works and answers */
  instructions: string;
  /** `examples.json` */
  examples: AgentExample[];
}

export interface AgentSummary {
  slug: string;
  id: string;
  title: string;
  description: string;
  tables: number;
  /** the included tables, for search */
  tableNames: string[];
  updatedAt: number;
}

export type AgentRating = "good" | "bad";

/** One question asked to an agent and how it answered. */
export interface AgentLogEntry {
  /** the id of the agent's message in the conversation */
  id: string;
  at: number;
  /** who asked (email; "" when sign-in is off) */
  user: string;
  threadId: string;
  question: string;
  answer: string;
  /** the SQL the agent ran, in order */
  queries: string[];
  /** how long the answer took */
  ms: number;
  /** the charts drawn under the answer */
  charts?: IaraChart[];
  rating: AgentRating | null;
  /** the reviewer's note on the answer */
  note: string;
}
