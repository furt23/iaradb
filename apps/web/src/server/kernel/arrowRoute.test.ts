import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/result-arrow/route";

import { KernelError } from "./client";

const fake = vi.hoisted(() => ({ requireUser: vi.fn(), existing: vi.fn(), request: vi.fn() }));
vi.mock("@/server/auth/session", () => ({
  requireUser: fake.requireUser,
  authErrorResponse: (e: unknown) => (e instanceof Error && e.name === "unauthorized" ? new Response("{}", { status: 401 }) : null),
}));
vi.mock("@/server/kernel/manager", () => ({ kernels: { existing: fake.existing } }));

const body = { kernel: "notebook:a.py", result: "0123456789ab", offset: 100, limit: 50, sort: [{ column: "x", descending: true }] };

function call(over: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Response> {
  const headers = { origin: "https://studio.example.com", host: "studio.example.com", "content-type": "application/json", ...over.headers };
  const payload = typeof over.body === "string" ? over.body : JSON.stringify(over.body ?? body);
  return POST(new Request("https://studio.example.com/api/result-arrow", { method: "POST", headers, body: payload }));
}

const arrow = (over: object = {}) => ({ offset: 100, total: 1234, rows: 2, data: Buffer.from([1, 2, 3, 4]).toString("base64"), ...over });

beforeEach(() => {
  vi.resetAllMocks();
  fake.requireUser.mockResolvedValue({ email: "ed@x.com" });
  fake.existing.mockReturnValue({ request: fake.request });
  fake.request.mockResolvedValue(arrow());
});

describe("POST /api/result-arrow", () => {
  it("relays the kernel's Arrow bytes with their position", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      "content-type": "application/vnd.apache.arrow.stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-disposition": "attachment",
      "x-iara-offset": "100",
      "x-iara-total": "1234",
    });
    expect(fake.existing).toHaveBeenCalledWith("notebook:a.py");
    expect(fake.request).toHaveBeenCalledWith("result.arrow", { result_id: "0123456789ab", offset: 100, limit: 50, sort: [{ column: "x", descending: true }] });
  });

  it("answers cross-site requests and non-JSON bodies before anything else", async () => {
    expect((await call({ headers: { origin: "https://evil.example.com" } })).status).toBe(403);
    expect((await call({ headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await call({ headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect(fake.requireUser).not.toHaveBeenCalled();
    expect(fake.existing).not.toHaveBeenCalled();
  });

  it("refuses a request without an Origin header", async () => {
    const req = new Request("https://studio.example.com/api/result-arrow", { method: "POST", headers: { host: "studio.example.com", "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await POST(req)).status).toBe(403);
    expect(fake.existing).not.toHaveBeenCalled();
  });

  it("checks who is asking before it reads the body or looks for a kernel", async () => {
    fake.requireUser.mockRejectedValue(Object.assign(new Error("sign in"), { name: "unauthorized" }));
    expect((await call()).status).toBe(401);
    expect(fake.existing).not.toHaveBeenCalled();
  });

  it("refuses a body that is not valid, before it looks for a kernel", async () => {
    expect((await call({ body: "{not json" })).status).toBe(400);
    expect((await call({ body: { ...body, result: "../x" } })).status).toBe(400);
    expect((await call({ body: { ...body, extra: true } })).status).toBe(400);
    expect((await call({ body: " ".repeat(20_000) })).status).toBe(413);
    expect(fake.existing).not.toHaveBeenCalled();
  });

  it("does not start a kernel: no live one is a missing result", async () => {
    fake.existing.mockReturnValue(undefined);
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("result not available; re-run the cell");
  });

  it("tells the browser to fall back when the kernel does not know the method", async () => {
    fake.request.mockRejectedValue(new KernelError("LookupError", "unknown method 'result.arrow'"));
    expect((await call()).status).toBe(501);
  });

  it("gives the kernel's own message for any other error", async () => {
    fake.request.mockRejectedValue(new KernelError("KeyError", "result 'x' is no longer available; re-run the cell"));
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.text()).toBe("result 'x' is no longer available; re-run the cell");
    // a missing result is not a missing method
    fake.request.mockRejectedValue(new KernelError("LookupError", "something else"));
    expect((await call()).status).toBe(409);
  });

  it("refuses a reply that is not a page, and one past 32 MiB", async () => {
    fake.request.mockResolvedValue({ offset: 0, total: 1 });
    expect((await call()).status).toBe(502);
    fake.request.mockResolvedValue(arrow({ data: Buffer.alloc(32 * 2 ** 20 + 1).toString("base64") }));
    expect((await call()).status).toBe(502);
  });

  it("has no GET", async () => {
    const route = await import("@/app/api/result-arrow/route");
    expect(Object.keys(route).filter((k) => /^(GET|PUT|PATCH|DELETE|HEAD)$/.test(k))).toEqual([]);
  });
});
