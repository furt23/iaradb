import type { Diagnostic } from "@iara/protocol";
import { z } from "zod";

import { IaraRequest } from "@/lib/iara/protocol";
import { agentAllow, agentBrief } from "@/server/agents/brief";
import { appendLog } from "@/server/agents/log";
import { recordingSend } from "@/server/agents/record";
import { readAgent } from "@/server/agents/store";
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
  if (ctx.surface !== "agent") return eventStream((send) => runTurn(body, deps, send, req.signal));

  let agent;
  try {
    agent = await readAgent(ctx.path);
  } catch (e) {
    return Response.json({ ok: false, error: { type: "NotFound", message: (e as Error).message } }, { status: 404 });
  }
  // the agent's tables bound what it reads, within the user's own grants
  const allow = agentAllow(deps.tools.allow, agent);
  const agentDeps: IaraDeps = { ...deps, tools: { ...deps.tools, allow }, agent: { brief: await agentBrief(agent, allow), charts: agent.config.style.charts !== "never" } };
  const question = body.kind === "message" ? body.text : "";
  return eventStream((send) =>
    runTurn(
      body,
      agentDeps,
      recordingSend(send, ({ messageId, threadId, answer, queries, ms, charts }) => {
        appendLog(agent.config.id, { id: messageId, at: Date.now(), user: user.email, threadId, question, answer, queries, ms, charts }).catch((e) => console.error("agent log:", e));
      }),
      req.signal,
    ),
  );
}
