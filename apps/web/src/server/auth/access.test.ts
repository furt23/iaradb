import { describe, expect, it } from "vitest";

import { authMode, isPublicPath, isViewerPath, isViewHost, isViewHostPath, missingAuth0Config, studioUser, surfaceAllowsStudio, viewHost } from "./access";

const env = { IARA_ALLOWED_EMAILS: " A@x.com, b@x.com ", IARA_ADMIN_EMAILS: "a@x.com" };

describe("authMode", () => {
  it("is off by default and on with an Auth0 domain", () => {
    expect(authMode({})).toBe("off");
    expect(authMode({ AUTH0_DOMAIN: "t.us.auth0.com" })).toBe("auth0");
  });
  it("follows IARA_AUTH", () => {
    expect(authMode({ IARA_AUTH: "off", AUTH0_DOMAIN: "t.us.auth0.com" })).toBe("off");
    expect(authMode({ IARA_AUTH: "auth0" })).toBe("auth0");
  });
});

describe("missingAuth0Config", () => {
  it("lists empty variables", () => {
    expect(missingAuth0Config({ AUTH0_DOMAIN: "d", AUTH0_CLIENT_ID: " " })).toEqual([
      "AUTH0_CLIENT_ID",
      "AUTH0_CLIENT_SECRET",
      "AUTH0_SECRET",
      "APP_BASE_URL",
    ]);
  });
});

describe("studioUser", () => {
  it("accepts verified emails on the allowlist, ignoring case", () => {
    expect(studioUser({ email: "a@X.com", email_verified: true, name: "A" }, env)).toEqual({ email: "a@x.com", name: "A", admin: true });
    expect(studioUser({ email: "a@x.com", email_verified: true, picture: "https://cdn/a.png" }, env)?.picture).toBe("https://cdn/a.png");
    expect(studioUser({ email: "a@x.com", email_verified: true, picture: "javascript:alert(1)" }, env)?.picture).toBeUndefined();
    expect(studioUser({ email: "b@x.com", email_verified: true }, env)).toEqual({ email: "b@x.com", name: "b@x.com", admin: false });
  });
  it("refuses unverified, unlisted and missing emails", () => {
    expect(studioUser({ email: "a@x.com", email_verified: false }, env)).toBeNull();
    expect(studioUser({ email: "a@x.com" }, env)).toBeNull();
    expect(studioUser({ email: "c@x.com", email_verified: true }, env)).toBeNull();
    expect(studioUser({ email_verified: true }, env)).toBeNull();
    expect(studioUser(null, env)).toBeNull();
  });
  it("refuses everyone when the allowlist is empty", () => {
    expect(studioUser({ email: "a@x.com", email_verified: true }, {})).toBeNull();
  });
});

describe("viewers", () => {
  const viewerEnv = { ...env, IARA_VIEWER_EMAILS: " V@x.com, b@x.com " };
  it("accepts verified emails on the viewer list, never as admin", () => {
    expect(studioUser({ email: "v@X.com", email_verified: true, name: "V" }, viewerEnv)).toEqual({ email: "v@x.com", name: "V", admin: false, viewer: true });
    expect(studioUser({ email: "v@x.com", email_verified: true }, { ...viewerEnv, IARA_ADMIN_EMAILS: "v@x.com" })?.admin).toBe(false);
    expect(studioUser({ email: "v@x.com", email_verified: true, picture: "https://cdn/v.png" }, viewerEnv)?.picture).toBe("https://cdn/v.png");
  });
  it("makes an email on both lists an editor", () => {
    expect(studioUser({ email: "b@x.com", email_verified: true }, viewerEnv)).toEqual({ email: "b@x.com", name: "b@x.com", admin: false });
  });
  it("refuses unverified viewers", () => {
    expect(studioUser({ email: "v@x.com", email_verified: false }, viewerEnv)).toBeNull();
    expect(studioUser({ email: "v@x.com" }, viewerEnv)).toBeNull();
  });
  it("opens only /view", () => {
    expect(isViewerPath("/view")).toBe(true);
    expect(isViewerPath("/view/abc")).toBe(true);
    expect(isViewerPath("/viewer")).toBe(false);
    expect(isViewerPath("/views")).toBe(false);
    expect(isViewerPath("/")).toBe(false);
  });
});

describe("paths", () => {
  it("knows public paths", () => {
    expect(isPublicPath("/auth/callback")).toBe(true);
    expect(isPublicPath("/healthz")).toBe(true);
    expect(isPublicPath("/authx")).toBe(false);
    expect(isPublicPath("/api/run")).toBe(false);
    expect(isPublicPath("/compute")).toBe(false);
  });
});

describe("view host", () => {
  it("is the normalized IARA_VIEW_HOST, null when unset or not a bare hostname", () => {
    expect(viewHost({ IARA_VIEW_HOST: " View-Team.IaraX.dev " })).toBe("view-team.iarax.dev");
    expect(viewHost({ IARA_VIEW_HOST: "localhost" })).toBe("localhost");
    expect(viewHost({})).toBeNull();
    expect(viewHost({ IARA_VIEW_HOST: " " })).toBeNull();
    for (const bad of ["https://view.iarax.dev", "view.iarax.dev:3870", "view.iarax.dev/", "view.iarax.dev.", "-a.dev", "a b.dev", ".dev", "a..dev"]) {
      expect(viewHost({ IARA_VIEW_HOST: bad })).toBeNull();
    }
  });
  it("matches the Host header without port, ignoring case and a trailing dot", () => {
    const env = { IARA_VIEW_HOST: "view-team.iarax.dev" };
    expect(isViewHost("view-team.iarax.dev", env)).toBe(true);
    expect(isViewHost("View-Team.iarax.dev:443", env)).toBe(true);
    expect(isViewHost("view-team.iarax.dev.", env)).toBe(true);
    expect(isViewHost("studio-team.iarax.dev", env)).toBe(false);
    expect(isViewHost("x.view-team.iarax.dev", env)).toBe(false);
    expect(isViewHost("view-team.iarax.dev.evil.com", env)).toBe(false);
    expect(isViewHost(null, env)).toBe(false);
    expect(isViewHost("", env)).toBe(false);
  });
  it("matches nothing when no view host is set", () => {
    expect(isViewHost("view-team.iarax.dev", {})).toBe(false);
    expect(isViewHost("", {})).toBe(false);
    expect(isViewHost(null, { IARA_VIEW_HOST: "https://view-team.iarax.dev" })).toBe(false);
  });
  it("serves only /view, sign-in, the health check and assets", () => {
    for (const ok of ["/view", "/view/abcd1234", "/auth/login", "/auth/callback", "/healthz", "/_next/static/a.js", "/_next/image", "/favicon.ico", "/icon.svg"]) {
      expect(isViewHostPath(ok)).toBe(true);
    }
    for (const no of ["/", "/api/run", "/api/mcp", "/compute", "/viewer", "/authx", "/me/profile", "/dashboards/abcd1234"]) {
      expect(isViewHostPath(no)).toBe(false);
    }
  });
  it("lets the Studio's actions through only without the surface header", () => {
    expect(surfaceAllowsStudio(null)).toBe(true);
    expect(surfaceAllowsStudio(undefined)).toBe(true);
    expect(surfaceAllowsStudio("view")).toBe(false);
    expect(surfaceAllowsStudio("")).toBe(false);
    expect(surfaceAllowsStudio("studio")).toBe(false);
  });
});
