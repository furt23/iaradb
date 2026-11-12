import { z } from "zod";

import { openaiLlm } from "@/server/ai/models";
import { assistantContext } from "@/server/ai/tools";
import { authErrorResponse, requireUser } from "@/server/auth/session";
import { DraftInput, runOntologyDraft } from "@/server/ontology/draftRun";
import { ontologyLocation } from "@/server/ontology/store";
import { eventStream } from "@/server/stream/sse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** a proxy in front of the Studio may close a connection that stays silent: a model call can take longer than this */
const PING_MS = 20_000;

/**
 * Drafts a team's ontology from the tables the request names. A draft takes
 * minutes, so it is streamed: `progress` events (and `ping`s) while it is
 * made, then `done` with what was written or `failed` with why.
 */
export async function POST(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    throw e;
  }
  const parsed = DraftInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ ok: false, error: { type: "invalid", message: z.prettifyError(parsed.error) } }, { status: 400 });

  return eventStream(async (send) => {
    const ping = setInterval(() => send("ping", null), PING_MS);
    try {
      const outcome = await runOntologyDraft(user, parsed.data, {
        llm: openaiLlm,
        tools: assistantContext(user),
        location: ontologyLocation(),
        onProgress: (p) => send("progress", p),
        signal: req.signal,
      });
      send("done", outcome);
    } catch (e) {
      if (!req.signal.aborted) send("failed", { message: (e as Error).message });
    } finally {
      clearInterval(ping);
    }
  });
}
