import type { AssistRequest } from "@workhouse/protocol";

import { assist } from "@/server/assist";
import { authErrorResponse, requireUser } from "@/server/auth/session";
import { attempt } from "@/server/result";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Completions, signatures and diagnostics for a notebook cell (an `ActionResult`). */
export async function POST(req: Request): Promise<Response> {
  try {
    await requireUser();
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    throw e;
  }
  const body = (await req.json()) as AssistRequest;
  return Response.json(await attempt(() => assist(body)));
}
