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
 * - `IARA_VIEWER_EMAILS`: comma-separated emails that may only open shared
 *   dashboards (`/view`). An email in both lists is an editor.
 * - `IARA_VIEW_HOST`: a second hostname (bare, no scheme or port) for the same
 *   Studio that serves nothing but `/view` and sign-in.
 */

export type AuthMode = "off" | "auth0";

export interface StudioUser {
  email: string;
  name: string;
  admin: boolean;
  /** may only open shared dashboards (`/view`), never the Studio */
  viewer?: boolean;
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
 * The Studio user for verified claims on the allowlist, a viewer for those on
 * the viewer list, else null. An unverified email is refused: anyone can sign
 * up with someone else's address.
 */
export function studioUser(claims: UserClaims | null | undefined, env: Env = process.env): StudioUser | null {
  if (!claims || claims.email_verified !== true || typeof claims.email !== "string") return null;
  const email = claims.email.trim().toLowerCase();
  const editor = emailList(env.IARA_ALLOWED_EMAILS).has(email);
  if (!editor && !emailList(env.IARA_VIEWER_EMAILS).has(email)) return null;
  const name = typeof claims.name === "string" && claims.name ? claims.name : email;
  const user: StudioUser = editor
    ? { email, name, admin: emailList(env.IARA_ADMIN_EMAILS).has(email) }
    : { email, name, admin: false, viewer: true };
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

/** Pages a viewer may open: `/view` and everything under it. */
export function isViewerPath(pathname: string): boolean {
  return pathname === "/view" || pathname.startsWith("/view/");
}

/** Paths the view host serves: shared dashboards, sign-in, the health check and static assets. */
export function isViewHostPath(pathname: string): boolean {
  return isViewerPath(pathname) || isPublicPath(pathname) || pathname.startsWith("/_next/") || pathname === "/icon.svg";
}

/** Request header the proxy sets to `view` on the view host; clients cannot send it (the proxy drops theirs). */
export const SURFACE_HEADER = "x-iara-surface";

/** Whether a request with this `x-iara-surface` value may use the Studio's actions: only one without the header (any value, even empty, is the view host). */
export function surfaceAllowsStudio(value: string | null | undefined): boolean {
  return value == null;
}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** `IARA_VIEW_HOST` lowercased, or null when unset or not a bare hostname. */
export function viewHost(env: Env = process.env): string | null {
  const host = env.IARA_VIEW_HOST?.trim().toLowerCase();
  return host && HOSTNAME.test(host) ? host : null;
}

/** Whether a request's `Host` header names the view host (port and the trailing dot of an absolute name ignored). */
export function isViewHost(hostHeader: string | null | undefined, env: Env = process.env): boolean {
  const view = viewHost(env);
  return view !== null && !!hostHeader && hostHeader.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "") === view;
}
