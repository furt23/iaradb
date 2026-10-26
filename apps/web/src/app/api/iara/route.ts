import type { Diagnostic } from "@iara/protocol";
import { z } from "zod";

import { IaraRequest } from "@/lib/iara/protocol";
import { openaiChat, openaiLlm } from "@/server/ai/models";
import { assistantContext } from "@/server/ai/tools";
import { assist } from "@/server/assist";
import { authErrorResponse, requireUser } from "@/server/auth/session";
import type { IaraDeps } from "@/server/iara/state";
import { runTurn } from "@/server/iara/turn";
import { eventStream } from "@/server/stream/sse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * One request to Iara: a message or the user's decision on a proposal. Streams
 * the agents' events (`thread`, `agent`, `text`, `tool`, `memory`, `usage`) and
 * ends with `approval` (waiting for the decision), `done` or `failed`.
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
  const parsed = IaraRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ ok: false, error: { type: "invalid", message: z.prettifyError(parsed.error) } }, { status: 400 });
  const body = parsed.data;

  const ctx = body.context;
  const lint: IaraDeps["lint"] =
    ctx.surface === "notebook"
      ? async (code, kind) => {
          try {
            const found = (await assist({ op: "lint", path: ctx.path, cellId: "iara-draft", kind, code })) as Diagnostic[] | null;
            return (found ?? []).map(({ severity, message }) => ({ severity, message }));
          } catch {
            // a lint that cannot run must not fail the review
            return [];
          }
        }
      : null;
  const deps: IaraDeps = { chat: openaiChat, llm: openaiLlm, tools: assistantContext(user), user, lint };
  return eventStream((send) => runTurn(body, deps, send, req.signal));
}
