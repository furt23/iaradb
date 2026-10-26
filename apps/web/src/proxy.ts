import { NextResponse, type NextRequest } from "next/server";

import { authMode, isPublicPath, isViewerPath, isViewHost, isViewHostPath, studioUser, SURFACE_HEADER, viewHost } from "@/server/auth/access";
import { auth0 } from "@/server/auth/auth0";
import { deniedPage } from "@/server/auth/deniedPage";

/**
 * Lets `res` through to the page, route or action with `x-iara-surface` set to
 * `surface`, or removed when null: the client's own copy never reaches the
 * app. Cookies and headers `res` carries (the Auth0 session roll) are kept.
 * A response the SDK answered itself (redirect, JSON) goes out untouched.
 */
function forward(res: NextResponse, req: NextRequest, surface: string | null): NextResponse {
  if (!res.headers.has("x-middleware-next")) return res;
  const headers = new Headers(req.headers);
  headers.delete(SURFACE_HEADER);
  if (surface) headers.set(SURFACE_HEADER, surface);
  return NextResponse.next({ request: { headers }, headers: res.headers });
}

/**
 * First check on every request. On the view host (`IARA_VIEW_HOST`, the same
 * Studio under a second name) only `/view`, sign-in and static assets are
 * served, whatever the sign-in setting; the request carries `x-iara-surface:
 * view`, which makes `requireUser` refuse every Studio action and route.
 *
 * When sign-in is on: the Auth0 routes (`/auth/*`) are served here, pages
 * without a session redirect to sign-in, and API calls and server actions get
 * 401/403. Viewers (shared dashboards only) may reach `/view` pages and
 * nothing else: other pages redirect to `/view`, the rest gets 403. Server
 * actions and route handlers check again (`requireUser`, or `requireViewer`
 * for the ones behind `/view`).
 */
export async function proxy(req: NextRequest): Promise<NextResponse> {
  const { pathname, search } = req.nextUrl;
  const page = req.method === "GET" && !req.headers.has("next-action") && !pathname.startsWith("/api/");

  // a view host that is set but unusable would leave the Studio open on it
  if (process.env.IARA_VIEW_HOST?.trim() && !viewHost()) {
    return new NextResponse("IARA_VIEW_HOST must be a bare hostname such as view-team.example.com", { status: 503 });
  }
  const view = isViewHost(req.headers.get("host"));
  if (view && !isViewHostPath(pathname)) {
    if (page) return NextResponse.redirect(new URL("/view", req.nextUrl.origin));
    return NextResponse.json({ ok: false, error: { type: "not_found", message: "there is nothing here" } }, { status: 404 });
  }
  const surface = view ? "view" : null;

  if (authMode() === "off" || pathname === "/healthz") return forward(NextResponse.next(), req, surface);

  let client;
  try {
    client = auth0();
  } catch (e) {
    return new NextResponse((e as Error).message, { status: 503 });
  }
  // mounts /auth/login, /auth/callback, /auth/logout and rolls the session cookie
  const res = forward(await client.middleware(req), req, surface);
  // MCP clients have no session: the route checks its own bearer token
  if (isPublicPath(pathname) || pathname === "/api/mcp") return res;

  const session = await client.getSession(req);
  if (!session) {
    if (!page) return NextResponse.json({ ok: false, error: { type: "unauthorized", message: "sign in to use the Studio" } }, { status: 401 });
    const login = new URL("/auth/login", req.nextUrl.origin);
    login.searchParams.set("returnTo", pathname + search);
    return NextResponse.redirect(login);
  }

  const user = studioUser(session.user);
  if (!user) {
    const message = "This account may not use this Studio.";
    if (!page) return NextResponse.json({ ok: false, error: { type: "forbidden", message } }, { status: 403 });
    return new NextResponse(deniedPage(message, typeof session.user.email === "string" ? session.user.email : ""), {
      status: 403,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (user.viewer && !isViewerPath(pathname)) {
    if (page) return NextResponse.redirect(new URL("/view", req.nextUrl.origin));
    return NextResponse.json({ ok: false, error: { type: "forbidden", message: "this account may only open shared dashboards" } }, { status: 403 });
  }
  return res;
}

export const config = {
  // everything but build assets; /auth/* must stay matched (the SDK serves it here)
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
