import "server-only";

import type { S3Client } from "@aws-sdk/client-s3";

import { mayTeachOntology, parseOntology, tableOf, TEAM_ID, type Ontology } from "@/lib/ontology";
import { checkLesson, mergeLesson, type LessonTable } from "@/lib/ontologyLearn";

import type { StudioUser } from "../auth/access";
import { describeTable, type ToolContext } from "../ai/tools";
import { ontologyLocation, readOntologyFile, reloadOntologies, writeOntologyFile, type OntologyLocation } from "./store";

/**
 * Iara's own writes to the ontology: when a team's owner (or an admin) states
 * a lasting rule in a conversation, she decides it belongs there and writes
 * it at the end of the team's file. Nobody fills the ontology by hand in the
 * Studio. Columns are checked against the tables the user may read.
 */

/** tables one lesson may name */
const MAX_TABLES = 20;

export interface LearnDeps {
  tools: ToolContext;
  location?: OntologyLocation;
  s3?: S3Client;
  /** YYYY-MM-DD, for the note over what is written */
  today?: string;
}

export interface Teachable {
  /** the teams whose file names the user as an owner (every readable team for an admin) */
  teams: { team: string; name: string }[];
  /** the user may start a new team's file (admins) */
  anyTeam: boolean;
}

/** Where what `user` says may be written; nothing when the ontology cannot be read now. */
export async function teachableTeams(user: StudioUser, tools: ToolContext): Promise<Teachable> {
  const anyTeam = mayTeachOntology(user, null);
  const loaded = await tools.ontologies?.().catch(() => null);
  const teams = (loaded?.ontologies ?? []).filter((o) => mayTeachOntology(user, o)).map((o) => ({ team: o.team, name: o.name }));
  return { teams, anyTeam };
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const field = (v: unknown, key: string): unknown => (v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined);

/** The tables the lesson's columns name, as the user may read them; a table that cannot be read leaves its columns out. */
async function tablesNamed(args: Record<string, unknown>, tools: ToolContext): Promise<LessonTable[]> {
  const columns = [
    ...list(args.terms).flatMap((t) => list(field(t, "columns"))),
    ...list(args.joins).flatMap((j) => [field(j, "left"), field(j, "right")]),
  ].filter((c): c is string => typeof c === "string");
  const names = [...new Set(columns.map((c) => tableOf(c.trim().toLowerCase())))].slice(0, MAX_TABLES);
  const out: LessonTable[] = [];
  for (const name of names) {
    try {
      const t = await describeTable(tools, name);
      out.push({ full: t.full, columns: t.columns.map((c) => c.name) });
    } catch {
      // not a table the user may read: checkLesson drops what names it
    }
  }
  return out;
}

/** Writes what the model decided to learn into `args.team`'s file and says what happened, for the model. Throws when nothing may be written. */
export async function learnOntology(user: StudioUser, args: Record<string, unknown>, deps: LearnDeps): Promise<string> {
  const team = typeof args.team === "string" ? args.team.trim().toLowerCase() : "";
  if (!TEAM_ID.test(team)) throw new Error("team is a team id: lowercase letters, digits, - and _");
  const location = deps.location ?? ontologyLocation();
  const stored = await readOntologyFile(location, team, { s3: deps.s3 });
  let existing: Ontology | null = null;
  if (stored) {
    try {
      existing = parseOntology(team, stored.text);
    } catch {
      throw new Error(`${team}'s ontology file cannot be read now: nothing was written`);
    }
  }
  if (!mayTeachOntology(user, existing)) throw new Error(`this user may not add to ${team}'s ontology`);

  const lesson = checkLesson(args, await tablesNamed(args, deps.tools));
  const name = typeof args.team_name === "string" ? args.team_name : undefined;
  const merged = mergeLesson(team, stored?.text ?? null, lesson, { name, by: user.email || user.name, date: deps.today ?? new Date().toISOString().slice(0, 10) });
  if (merged.terms + merged.joins > 0) {
    await writeOntologyFile(location, team, merged.text, stored, { s3: deps.s3 });
    reloadOntologies();
  }
  return [
    `Written to ${team}: ${merged.terms} terms, ${merged.joins} joins.`,
    merged.known > 0 && `${merged.known} were already there and were not changed.`,
    lesson.dropped > 0 && `${lesson.dropped} were left out: a column does not exist or the user may not read its table, or a term had no name or description.`,
  ]
    .filter(Boolean)
    .join(" ");
}
