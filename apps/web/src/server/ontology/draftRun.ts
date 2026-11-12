import "server-only";

import type { S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";

import { mayDraftOntology, parseOntology, TEAM_ID, type Ontology } from "@/lib/ontology";
import { mergeDraft, type DraftOutcome } from "@/lib/ontologyDraft";

import type { StudioUser } from "../auth/access";
import { draftOntology, type DraftDeps } from "./draft";
import { readOntologyFile, reloadOntologies, writeOntologyFile, type OntologyLocation } from "./store";

/** What the browser asks for (a trust boundary: parsed before anything is read). */
export const DraftInput = z.strictObject({
  team: z.string().regex(TEAM_ID, "a team id has lowercase letters, digits, - and _"),
  /** the team's name, for a team that has no file yet */
  name: z.string().trim().max(200).optional(),
  scope: z.array(z.string().max(400)).min(1, "choose the catalogs, schemas or tables to read").max(100),
  samples: z.boolean(),
  language: z.enum(["pt", "en"]),
});
export type DraftInput = z.infer<typeof DraftInput>;

export interface DraftRunDeps extends DraftDeps {
  location: OntologyLocation;
  s3?: S3Client;
  /** today, as the note over the draft dates it (YYYY-MM-DD) */
  today?: string;
}

/**
 * Has a model draft terms and joins for a team from the tables in the
 * request's scope, read with the user's grants, and writes them at the end of
 * the team's file as drafts. Admins may do it for any team, a team's owners
 * for theirs. Nothing is written when the draft brings nothing new, when it
 * was aborted, or when the file changed while it was made.
 */
export async function runOntologyDraft(user: StudioUser, input: DraftInput, deps: DraftRunDeps): Promise<DraftOutcome> {
  const { team, name, scope, samples, language } = input;
  const { location, s3 } = deps;
  const stored = await readOntologyFile(location, team, { s3 });
  let existing: Ontology | null = null;
  if (stored) {
    try {
      existing = parseOntology(team, stored.text);
    } catch (e) {
      // what is wrong with a file is told to those who may read every file
      throw new Error(user.admin ? `${team}.toml cannot be read, fix it first: ${(e as Error).message}` : `${team}.toml cannot be read: ask a team admin to fix it`);
    }
  }
  if (!mayDraftOntology(user, existing)) throw new Error("only team admins and the owners a team's file names may write drafts into it");

  const draft = await draftOntology(deps, { scope, samples, language, existing: existing?.terms.map((t) => t.name) ?? [] });
  const merged = mergeDraft(team, stored?.text ?? null, draft, { name, date: deps.today ?? new Date().toISOString().slice(0, 10) });
  deps.signal?.throwIfAborted();
  if (merged.terms + merged.joins > 0) {
    await writeOntologyFile(location, team, merged.text, stored, { s3 });
    reloadOntologies();
  }
  return { team, terms: merged.terms, joins: merged.joins, known: merged.known, dropped: draft.dropped, tables: draft.tables.length, sampled: draft.sampled, sampleError: draft.sampleError };
}
