"use server";

import type { AskAnswer, AskDecision, AskReply } from "@/lib/dashboards/ask";

import { resumeAsk, startAsk, threadSlug, type AskDeps } from "../ai/askGraph";
import { openaiLlm } from "../ai/models";
import type { StudioUser } from "../auth/access";
import { requireUser } from "../auth/session";
import { readDashboard } from "../dashboards/store";
import { userAllow } from "../governance/store";
import { kernels } from "../kernel/manager";
import { attempt, type ActionResult } from "../result";

/** The dashboard as it is on disk, its kernel, and the user's grants: the engine checks every query against them. */
async function depsFor(slug: string, user: StudioUser): Promise<AskDeps> {
  const dashboard = await readDashboard(slug);
  const { id, cluster } = dashboard.config;
  return {
    llm: openaiLlm,
    dashboard,
    tools: { request: async (method, params) => kernels.forDashboard(id, cluster).request(method, params), allow: userAllow(user) },
  };
}

/** Ask a question about the data: runs until a proposal waits for the user's decision (`answerAskAction`), or ends with a message. Nothing is saved yet. */
export async function askAction(slug: string, question: string): Promise<ActionResult<AskReply>> {
  return attempt(async () => {
    const user = await requireUser();
    return startAsk(await depsFor(slug, user), user.email, question);
  });
}

/** The user's decision on a proposal: approve saves the dataset, widget and layout; change asks for another proposal; cancel ends it. */
export async function answerAskAction(thread: string, decision: AskDecision): Promise<ActionResult<AskAnswer>> {
  return attempt(async () => {
    const user = await requireUser();
    const slug = threadSlug(thread, user.email);
    return resumeAsk(await depsFor(slug, user), thread, user.email, decision);
  });
}
