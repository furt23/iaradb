import "server-only";

import { headers } from "next/headers";

import { authMode, LOCAL_USER, SURFACE_HEADER, studioUser, surfaceAllowsStudio, type StudioUser } from "./access";
import { auth0 } from "./auth0";

export class AuthError extends Error {
  constructor(
    readonly type: "unauthorized" | "forbidden",
    message: string,
  ) {
    super(message);
    this.name = type;
  }

  get status(): number {
    return this.type === "unauthorized" ? 401 : 403;
  }
}

/** The signed-in user the Studio knows, an editor or a viewer (check `viewer`), or null. */
export async function currentUser(): Promise<StudioUser | null> {
  if (authMode() === "off") return LOCAL_USER;
  const session = await auth0().getSession();
  return studioUser(session?.user);
}

/**
 * The signed-in user the Studio knows, editor or viewer, or throw `AuthError`.
 * Only the actions that serve `/view` pages use this; everything else calls
 * `requireUser`.
 */
export async function requireViewer(): Promise<StudioUser> {
  if (authMode() === "off") return LOCAL_USER;
  const session = await auth0().getSession();
  if (!session) throw new AuthError("unauthorized", "sign in to use the Studio");
  const user = studioUser(session.user);
  if (!user) throw new AuthError("forbidden", "this account may not use this Studio");
  return user;
}

/**
 * The signed-in editor, or throw `AuthError`; viewers are refused, and so is
 * every request that came through the view host, whoever is signed in. Every
 * server action and route handler calls this first: the proxy alone is not
 * enough, since a wrong matcher would leave a route open.
 */
export async function requireUser(): Promise<StudioUser> {
  if (!surfaceAllowsStudio((await headers()).get(SURFACE_HEADER))) throw new AuthError("forbidden", "this page only shows shared dashboards");
  const user = await requireViewer();
  if (user.viewer) throw new AuthError("forbidden", "this account may only open shared dashboards");
  return user;
}

/** The signed-in team admin, or throw `AuthError`: for what members may read or change. */
export async function requireAdmin(): Promise<StudioUser> {
  const user = await requireUser();
  if (!user.admin) throw new AuthError("forbidden", "only team admins may change permissions");
  return user;
}

/** A JSON response for a failed check, for route handlers. */
export function authErrorResponse(e: unknown): Response | null {
  if (!(e instanceof AuthError)) return null;
  return Response.json({ ok: false, error: { type: e.type, message: e.message } }, { status: e.status });
}
