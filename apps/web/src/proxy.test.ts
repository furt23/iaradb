import { NextRequest, NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { proxy } from "./proxy";

// stands in for the Auth0 SDK: it rolls the session cookie and knows one editor
vi.mock("@/server/auth/auth0", () => ({
  auth0: () => ({
    middleware: async () => {
      const res = NextResponse.next();
      res.cookies.set("__session", "rolled");
      return res;
    },
    getSession: async () => ({ user: { email: "e@x.com", email_verified: true } }),
  }),
}));

const VIEW = "view-team.iarax.dev";

function request(host: string, path: string, init: { method?: string; headers?: Record<string, string> } = {}): NextRequest {
  return new NextRequest(`http://${host}${path}`, { method: init.method, headers: { host, ...init.headers } });
}

/** What the page, route or action will see of the request headers (Next's override protocol). */
function forwarded(res: NextResponse): { kept: string[]; surface: string | null } {
  return {
    kept: (res.headers.get("x-middleware-override-headers") ?? "").split(","),
    surface: res.headers.get("x-middleware-request-x-iara-surface"),
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("proxy on the view host", () => {
  it("forwards /view with the view surface, replacing the client's header, with sign-in off", async () => {
    vi.stubEnv("IARA_AUTH", "off");
    vi.stubEnv("IARA_VIEW_HOST", VIEW);
    const res = await proxy(request(VIEW, "/view/abcd1234", { headers: { "x-iara-surface": "studio" } }));
    expect(forwarded(res).surface).toBe("view");
  });

  it("forwards with the view surface and keeps the session cookie with sign-in on", async () => {
    vi.stubEnv("IARA_AUTH", "auth0");
    vi.stubEnv("IARA_ALLOWED_EMAILS", "e@x.com");
    vi.stubEnv("IARA_VIEW_HOST", `${VIEW}`);
    const res = await proxy(request(`${VIEW}:443`, "/view"));
    expect(forwarded(res).surface).toBe("view");
    expect(res.cookies.get("__session")?.value).toBe("rolled");
  });

  it("sends other pages to /view and answers other requests with 404 JSON", async () => {
    vi.stubEnv("IARA_AUTH", "off");
    vi.stubEnv("IARA_VIEW_HOST", VIEW);
    const page = await proxy(request(VIEW, "/compute"));
    expect(page.status).toBe(307);
    expect(new URL(page.headers.get("location")!).pathname).toBe("/view");
    // a server action posts to a page URL with this header
    const action = await proxy(request(VIEW, "/compute", { method: "POST", headers: { "next-action": "abc" } }));
    expect(action.status).toBe(404);
    for (const [path, method] of [["/api/run", "GET"], ["/api/run", "POST"], ["/api/mcp", "POST"]]) {
      expect((await proxy(request(VIEW, path, { method }))).status).toBe(404);
    }
    expect(await action.json()).toMatchObject({ ok: false, error: { type: "not_found" } });
  });

  it("refuses every request when the view host is set but not a bare hostname", async () => {
    vi.stubEnv("IARA_AUTH", "off");
    vi.stubEnv("IARA_VIEW_HOST", `https://${VIEW}`);
    expect((await proxy(request(VIEW, "/view"))).status).toBe(503);
    expect((await proxy(request("studio.iarax.dev", "/"))).status).toBe(503);
  });
});

describe("proxy on the Studio host", () => {
  it("drops the client's surface header and sets none", async () => {
    vi.stubEnv("IARA_AUTH", "off");
    vi.stubEnv("IARA_VIEW_HOST", VIEW);
    const res = await proxy(request("studio-team.iarax.dev", "/compute", { headers: { "x-iara-surface": "view", "x-keep": "1" } }));
    const { kept, surface } = forwarded(res);
    expect(surface).toBeNull();
    expect(kept).not.toContain("x-iara-surface");
    expect(kept).toContain("x-keep");
  });

  it("drops it with sign-in on too, and without a view host", async () => {
    vi.stubEnv("IARA_AUTH", "auth0");
    vi.stubEnv("IARA_ALLOWED_EMAILS", "e@x.com");
    const res = await proxy(request("studio-team.iarax.dev", "/compute", { headers: { "x-iara-surface": "" } }));
    expect(forwarded(res).kept).not.toContain("x-iara-surface");
    expect(res.cookies.get("__session")?.value).toBe("rolled");
  });
});
