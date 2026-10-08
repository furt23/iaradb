import type { AssistRequest } from "@workhouse/protocol";

import { assist } from "@/server/assist";
import { attempt } from "@/server/result";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Completions, signatures and diagnostics for a notebook cell (an `ActionResult`). */
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as AssistRequest;
  return Response.json(await attempt(() => assist(body)));
}
