import { handleMcp } from "@/server/ai/mcp";
import { assistantContext } from "@/server/ai/tools";
import { authMode, LOCAL_USER, type StudioUser } from "@/server/auth/access";
import { userForToken } from "@/server/auth/tokens";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The MCP server (Streamable HTTP, JSON responses): the Studio's read-only tools for an MCP client. */

const UNAUTHORIZED = { jsonrpc: "2.0", id: null, error: { code: -32001, message: "a valid Iara access token is required" } };

/** A browser's Origin must be this Studio's host (other clients send none). */
function sameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** The user a request acts as: the local user when sign-in is off, else the owner of its bearer token. */
function userOf(req: Request): StudioUser | null {
  if (authMode() === "off") return LOCAL_USER;
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  return token ? userForToken(token) : null;
}

export async function POST(req: Request): Promise<Response> {
  if (!sameOrigin(req.headers.get("origin"), req.headers.get("host"))) return new Response("forbidden origin", { status: 403 });
  const user = userOf(req);
  if (!user) return Response.json(UNAUTHORIZED, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
  }
  const result = await handleMcp(body, assistantContext(user));
  return result === null ? new Response(null, { status: 202 }) : Response.json(result);
}

/** No server-initiated stream and no sessions to end. */
export function GET(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

export const DELETE = GET;
