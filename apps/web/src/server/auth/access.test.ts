import { describe, expect, it } from "vitest";

import { authMode, isPublicPath, missingAuth0Config, studioUser } from "./access";

const env = { WORKHOUSE_ALLOWED_EMAILS: " A@x.com, b@x.com ", WORKHOUSE_ADMIN_EMAILS: "a@x.com" };

describe("authMode", () => {
  it("is off by default and on with an Auth0 domain", () => {
    expect(authMode({})).toBe("off");
    expect(authMode({ AUTH0_DOMAIN: "t.us.auth0.com" })).toBe("auth0");
  });
  it("follows WORKHOUSE_AUTH", () => {
    expect(authMode({ WORKHOUSE_AUTH: "off", AUTH0_DOMAIN: "t.us.auth0.com" })).toBe("off");
    expect(authMode({ WORKHOUSE_AUTH: "auth0" })).toBe("auth0");
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

describe("paths", () => {
  it("knows public paths", () => {
    expect(isPublicPath("/auth/callback")).toBe(true);
    expect(isPublicPath("/healthz")).toBe(true);
    expect(isPublicPath("/authx")).toBe(false);
    expect(isPublicPath("/api/run")).toBe(false);
    expect(isPublicPath("/compute")).toBe(false);
  });
});
