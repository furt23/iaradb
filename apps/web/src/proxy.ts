import { NextResponse, type NextRequest } from "next/server";

import { authMode, isPublicPath, studioUser } from "@/server/auth/access";
import { auth0 } from "@/server/auth/auth0";
import { deniedPage } from "@/server/auth/deniedPage";

/**
 * First check on every request when sign-in is on: the Auth0 routes
 * (`/auth/*`) are served here, pages without a session redirect to sign-in,
 * and API calls and server actions get 401/403. Server actions and route
 * handlers check again (`requireUser`).
 */
export async function proxy(req: NextRequest): Promise<NextResponse> {
  if (authMode() === "off") return NextResponse.next();
  const { pathname, search } = req.nextUrl;
  if (pathname === "/healthz") return NextResponse.next();

  let client;
  try {
    client = auth0();
  } catch (e) {
    return new NextResponse((e as Error).message, { status: 503 });
  }
  // mounts /auth/login, /auth/callback, /auth/logout and rolls the session cookie
  const res = await client.middleware(req);
  if (isPublicPath(pathname)) return res;

  const session = await client.getSession(req);
  const page = req.method === "GET" && !req.headers.has("next-action") && !pathname.startsWith("/api/");
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
  return res;
}

export const config = {
  // everything but build assets; /auth/* must stay matched (the SDK serves it here)
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
