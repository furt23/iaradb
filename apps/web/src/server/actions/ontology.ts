"use server";

import { mayDraftOntology, readableOntology, type OntologyOverview } from "@/lib/ontology";

import { assistantContext, listTables } from "../ai/tools";
import { requireUser } from "../auth/session";
import { canRead } from "../governance/grants";
import { ontologiesFor, ontologyLocation } from "../ontology/store";
import { attempt, type ActionResult } from "../result";

/** The teams' ontologies as the user may read them, and what they may do with them. */
export async function ontologyOverviewAction(): Promise<ActionResult<OntologyOverview>> {
  return attempt(async () => {
    const user = await requireUser();
    const ctx = assistantContext(user);
    const { ontologies, problems } = await ontologiesFor(user);
    const location = ontologyLocation();
    // the terms are worth reading even when the catalog cannot be listed
    const tables = await listTables(ctx).then(
      (list) => ({ names: list.map((t) => t.full), error: null }),
      (e: Error) => ({ names: [] as string[], error: e.message }),
    );
    return {
      teams: ontologies.map((o) => ({ ...readableOntology(o, (table) => canRead(ctx.allow, table)), canDraft: mayDraftOntology(user, o) })),
      problems,
      canCreate: mayDraftOntology(user, null),
      tables: tables.names,
      tablesError: tables.error,
      where: location.kind === "s3" ? `s3://${location.bucket}/_iara/ontology/` : location.dir,
    };
  });
}
