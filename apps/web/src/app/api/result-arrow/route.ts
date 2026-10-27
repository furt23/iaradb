import { authErrorResponse, requireUser } from "@/server/auth/session";
import { crossSiteProblem, isJsonRequest, MAX_BODY_BYTES, parseArrowReply, parseArrowRequest } from "@/server/kernel/arrowRequest";
import { KernelError } from "@/server/kernel/client";
import { kernels } from "@/server/kernel/manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const text = (message: string, status: number): Response => new Response(message, { status });

/** An older kernel (on a cluster) does not know the method: the browser falls back to JSON pages. */
const isUnknownMethod = (e: unknown): boolean => e instanceof KernelError && e.type === "LookupError" && e.message.startsWith("unknown method");

/**
 * A page of a kernel's result as an Arrow IPC stream (the bytes the kernel
 * made, relayed as they are). Browser calls only: same origin, JSON body, a
 * signed-in editor; it never starts a kernel.
 */
export async function POST(req: Request): Promise<Response> {
  const cross = crossSiteProblem(req.headers);
  if (cross) return text(cross, 403);
  if (!isJsonRequest(req.headers)) return text("send application/json", 415);
  try {
    await requireUser();
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    throw e;
  }

  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return text("request too large", 413);
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return text("request too large", 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return text("the body is not JSON", 400);
  }
  const parsed = parseArrowRequest(body);
  if (!parsed.ok) return text(parsed.message, 400);
  const { kernel: key, result, offset, limit, sort } = parsed.value;

  const kernel = kernels.existing(key);
  if (!kernel) return text("result not available; re-run the cell", 404);
  let reply: unknown;
  try {
    // typed by the protocol, but checked anyway: the kernel runs user code
    reply = await kernel.request("result.arrow", { result_id: result, offset, limit, sort });
  } catch (e) {
    if (isUnknownMethod(e)) return text("result.arrow is not supported by this kernel", 501);
    return text((e as Error).message, 409);
  }

  const page = parseArrowReply(reply);
  if (!page.ok) return text(page.message, 502);
  return new Response(page.value.bytes, {
    headers: {
      "Content-Type": "application/vnd.apache.arrow.stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "attachment",
      "X-Iara-Offset": String(page.value.offset),
      "X-Iara-Total": String(page.value.total),
    },
  });
}
