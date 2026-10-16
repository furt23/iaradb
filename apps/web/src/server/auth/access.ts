/**
 * Who may use the Studio. Pure functions over the environment and the
 * session's user claims, so the proxy, server actions and route handlers
 * apply the same rules.
 *
 * - `IARA_AUTH`: `off` disables sign-in (a Studio on your own machine);
 *   `auth0` requires it. Unset: required when `AUTH0_DOMAIN` is set.
 * - `IARA_ALLOWED_EMAILS`: comma-separated emails that may sign in.
 *   Empty means nobody.
 * - `IARA_ADMIN_EMAILS`: team admins. Every member may use clusters;
 *   admins may also edit and delete any cluster, not only their own.
 */

export type AuthMode = "off" | "auth0";

export interface StudioUser {
  email: string;
  name: string;
  admin: boolean;
  /** the identity provider's avatar (an https URL), when it has one */
  picture?: string;
}

export interface UserClaims {
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  picture?: unknown;
}

type Env = Record<string, string | undefined>;

export function authMode(env: Env = process.env): AuthMode {
  const mode = env.IARA_AUTH?.trim().toLowerCase();
  if (mode === "off") return "off";
  if (mode === "auth0" || env.AUTH0_DOMAIN) return "auth0";
  return "off";
}

/** Variables the Auth0 SDK needs; empty when sign-in can work. */
export function missingAuth0Config(env: Env = process.env): string[] {
  const names = ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_SECRET", "APP_BASE_URL"];
  return names.filter((n) => !env[n]?.trim());
}

export function emailList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * The Studio user for verified claims on the allowlist, else null. An
 * unverified email is refused: anyone can sign up with someone else's address.
 */
export function studioUser(claims: UserClaims | null | undefined, env: Env = process.env): StudioUser | null {
  if (!claims || claims.email_verified !== true || typeof claims.email !== "string") return null;
  const email = claims.email.trim().toLowerCase();
  if (!emailList(env.IARA_ALLOWED_EMAILS).has(email)) return null;
  const name = typeof claims.name === "string" && claims.name ? claims.name : email;
  const user: StudioUser = { email, name, admin: emailList(env.IARA_ADMIN_EMAILS).has(email) };
  if (typeof claims.picture === "string" && claims.picture.startsWith("https://")) user.picture = claims.picture;
  return user;
}

/** The user when sign-in is off: everything is allowed. */
export const LOCAL_USER: StudioUser = { email: "", name: "local", admin: true };

/** Paths served without a session: sign-in routes, health check, static assets. */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/healthz" ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/_next/static/") ||
    pathname.startsWith("/_next/image") ||
    pathname === "/favicon.ico"
  );
}
