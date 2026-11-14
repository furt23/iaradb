/** The agent's files, checked (pure). They are edited in the Studio and in Git, so both are read with these. */

import { z } from "zod";

import type { AgentConfig, AgentExample } from "./types";

export const AGENT_ID = /^[a-z0-9]{8}$/;
export const AGENT_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MAX_INSTRUCTIONS = 20_000;
export const MAX_TABLES = 100;
export const MAX_EXAMPLES = 100;
export const MAX_TERMS = 200;
const MAX_NOTE = 4000;
const MAX_SQL = 20_000;

const TABLE_NAME = /^[^\s.]+\.[^\s.]+\.[^\s.]+$/;

export const AgentConfigSchema = z.strictObject({
  id: z.string().regex(AGENT_ID, "id is 8 lowercase letters or digits"),
  title: z.string().trim().min(1, "the agent needs a name").max(120),
  description: z.string().max(1000),
  tables: z
    .array(
      z.strictObject({
        name: z.string().trim().toLowerCase().regex(TABLE_NAME, "a table is catalog.schema.table"),
        included: z.boolean().default(true),
        note: z.string().max(MAX_NOTE),
        columns: z.record(z.string().max(256), z.string().max(MAX_NOTE)).default({}),
      }),
    )
    .max(MAX_TABLES)
    .refine((ts) => new Set(ts.map((t) => t.name)).size === ts.length, "a table is listed twice"),
  glossary: z
    .array(z.strictObject({ term: z.string().trim().min(1, "a term needs its name").max(200), definition: z.string().max(MAX_NOTE) }))
    .max(MAX_TERMS)
    .default([]),
  style: z
    .strictObject({
      language: z.enum(["auto", "pt", "en"]).default("auto"),
      length: z.enum(["short", "balanced", "detailed"]).default("balanced"),
      charts: z.enum(["auto", "often", "never"]).default("auto"),
      tone: z.string().max(500).default(""),
    })
    .default({ language: "auto", length: "balanced", charts: "auto", tone: "" }),
});

export const AgentExamplesSchema = z
  .array(z.strictObject({ question: z.string().trim().min(1, "an example needs its question").max(2000), sql: z.string().max(MAX_SQL) }))
  .max(MAX_EXAMPLES);

export const InstructionsSchema = z.string().max(MAX_INSTRUCTIONS, `instructions are limited to ${MAX_INSTRUCTIONS} characters`);

const parsed = <T>(schema: z.ZodType<T>, value: unknown, what: string): T => {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(`${what}: ${r.error.issues[0].message}`);
  return r.data;
};

export const checkConfig = (value: unknown): AgentConfig => parsed(AgentConfigSchema, value, "agent.json");
export const checkExamples = (value: unknown): AgentExample[] => parsed(AgentExamplesSchema, value, "examples.json");
export const checkInstructions = (value: unknown): string => parsed(InstructionsSchema, value, "instructions");
