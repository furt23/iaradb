import "server-only";

import { authMode, LOCAL_USER, studioUser, type StudioUser } from "./access";
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

/** The signed-in user, or null (no session, or not on the allowlist). */
export async function currentUser(): Promise<StudioUser | null> {
  if (authMode() === "off") return LOCAL_USER;
  const session = await auth0().getSession();
  return studioUser(session?.user);
}

/**
 * The signed-in user, or throw `AuthError`. Every server action and route
 * handler calls this first: the proxy alone is not enough, since a wrong
 * matcher would leave a route open.
 */
export async function requireUser(): Promise<StudioUser> {
  if (authMode() === "off") return LOCAL_USER;
  const session = await auth0().getSession();
  if (!session) throw new AuthError("unauthorized", "sign in to use the Studio");
  const user = studioUser(session.user);
  if (!user) throw new AuthError("forbidden", "this account may not use this Studio");
  return user;
}

/** A JSON response for a failed check, for route handlers. */
export function authErrorResponse(e: unknown): Response | null {
  if (!(e instanceof AuthError)) return null;
  return Response.json({ ok: false, error: { type: e.type, message: e.message } }, { status: e.status });
}
