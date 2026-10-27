import { describe, expect, it } from "vitest";

import { crossSiteProblem, isJsonRequest, MAX_ARROW_BYTES, parseArrowReply, parseArrowRequest } from "./arrowRequest";

const valid = { kernel: "notebook:a/b.py", result: "0123456789ab", offset: 0, limit: 100 };

describe("cross-site check", () => {
  const same = { origin: "https://studio.example.com", host: "studio.example.com" };

  it("lets the Studio's own pages through", () => {
    expect(crossSiteProblem(new Headers(same))).toBeNull();
    expect(crossSiteProblem(new Headers({ ...same, "sec-fetch-site": "same-origin" }))).toBeNull();
    expect(crossSiteProblem(new Headers({ origin: "http://localhost:3870", host: "localhost:3870" }))).toBeNull();
  });

  it("refuses another site, another port, a missing or opaque origin and a missing host", () => {
    expect(crossSiteProblem(new Headers({ ...same, origin: "https://evil.example.com" }))).toBe("forbidden origin");
    expect(crossSiteProblem(new Headers({ origin: "http://localhost:3871", host: "localhost:3870" }))).toBe("forbidden origin");
    expect(crossSiteProblem(new Headers({ origin: "https://studio.example.com.evil.com", host: "studio.example.com" }))).toBe("forbidden origin");
    expect(crossSiteProblem(new Headers({ host: same.host }))).toBe("forbidden origin");
    expect(crossSiteProblem(new Headers({ ...same, origin: "null" }))).toBe("forbidden origin");
    expect(crossSiteProblem(new Headers({ origin: same.origin }))).toBe("forbidden origin");
  });

  it("refuses a fetch metadata that is not same-origin, whatever the origin says", () => {
    for (const site of ["cross-site", "same-site", "none", ""]) {
      expect(crossSiteProblem(new Headers({ ...same, "sec-fetch-site": site }))).toBe("forbidden origin");
    }
  });

  it("wants a JSON content type", () => {
    expect(isJsonRequest(new Headers({ "content-type": "application/json" }))).toBe(true);
    expect(isJsonRequest(new Headers({ "content-type": "Application/JSON; charset=utf-8" }))).toBe(true);
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/jsonx"]) {
      expect(isJsonRequest(new Headers({ "content-type": type }))).toBe(false);
    }
    expect(isJsonRequest(new Headers())).toBe(false);
  });
});

describe("request body", () => {
  const ok = (body: unknown) => {
    const r = parseArrowRequest(body);
    if (!r.ok) throw new Error(r.message);
    return r.value;
  };
  const bad = (body: unknown) => {
    const r = parseArrowRequest(body);
    if (r.ok) throw new Error("accepted");
    return r.message;
  };

  it("accepts a valid body, with or without a sort", () => {
    expect(ok(valid)).toEqual(valid);
    expect(ok({ ...valid, kernel: "workspace", sort: [] })).toEqual({ ...valid, kernel: "workspace", sort: [] });
    const sort = [{ column: "a" }, { column: "b c", descending: true }, { column: "x".repeat(256), descending: false }];
    expect(ok({ ...valid, offset: 2 ** 31 - 1, limit: 10_000, sort })).toEqual({ ...valid, offset: 2 ** 31 - 1, limit: 10_000, sort });
  });

  it("keeps the kernel key the manager knows", () => {
    expect(ok({ ...valid, kernel: "notebook:a\\b.py" }).kernel).toBe("notebook:a/b.py");
    expect(ok({ ...valid, kernel: "dashboard:abcd1234" }).kernel).toBe("dashboard:abcd1234");
  });

  it("refuses what is not an object, and unknown keys", () => {
    for (const body of [null, "x", 1, [], [valid]]) expect(bad(body)).toBe("the body must be a JSON object");
    expect(bad({ ...valid, extra: 1 })).toBe("unknown field: extra");
    expect(bad(JSON.parse('{"__proto__": {"a": 1}, "kernel": "workspace"}'))).toContain("unknown field");
  });

  it("refuses a kernel that is not a key", () => {
    for (const kernel of [undefined, null, 1, "", "job:run1", "other", "notebook:../x.py", "dashboard:BAD", {}]) expect(bad({ ...valid, kernel })).toBe("invalid kernel");
  });

  it("refuses a result that is not a 12-digit hex id", () => {
    for (const result of [undefined, 12, "", "0123456789a", "0123456789abc", "0123456789AB", "0123456789ag", "../0123456789", " 0123456789a"]) {
      expect(bad({ ...valid, result })).toBe("invalid result");
    }
  });

  it("refuses an offset that is not an integer in [0, 2^31)", () => {
    for (const offset of [undefined, -1, 1.5, 2 ** 31, NaN, Infinity, "0", null, 1n]) expect(bad({ ...valid, offset })).toBe("invalid offset");
  });

  it("refuses a limit that is not an integer in [1, 10000]", () => {
    for (const limit of [undefined, 0, -1, 10_001, 1.5, NaN, "100", null]) expect(bad({ ...valid, limit })).toBe("invalid limit");
  });

  it("refuses a sort that is not at most 8 keys of a name and a flag", () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ column: `c${i}` }));
    for (const sort of [null, "a", {}, nine, [null], ["a"], [{}], [{ column: "" }], [{ column: "x".repeat(257) }], [{ column: 1 }], [{ column: "a", descending: "yes" }], [{ column: "a", extra: 1 }], [[]]]) {
      expect(bad({ ...valid, sort })).toBe("invalid sort");
    }
    expect(ok({ ...valid, sort: nine.slice(0, 8) }).sort).toHaveLength(8);
  });

  it("requires every field but the sort", () => {
    for (const key of ["kernel", "result", "offset", "limit"]) {
      const { [key]: _gone, ...rest } = valid as Record<string, unknown>;
      expect(parseArrowRequest(rest).ok).toBe(false);
    }
  });
});

describe("kernel reply", () => {
  const reply = (bytes: Buffer, over: object = {}) => ({ offset: 5, total: 50, rows: 2, data: bytes.toString("base64"), ...over });

  it("decodes the Arrow bytes and keeps the position", () => {
    const r = parseArrowReply(reply(Buffer.from([1, 2, 3, 4, 5])));
    expect(r.ok && r.value.offset).toBe(5);
    expect(r.ok && r.value.total).toBe(50);
    expect(r.ok && [...r.value.bytes]).toEqual([1, 2, 3, 4, 5]);
  });

  it("refuses a reply of the wrong shape", () => {
    const data = Buffer.from([1]).toString("base64");
    for (const r of [null, "x", [], {}, { offset: 0, total: 0, rows: 0 }, { offset: 0, total: 0, rows: 0, data: 5 }, { offset: -1, total: 0, rows: 0, data }, { offset: 0, total: 1.5, rows: 0, data }, { offset: 0, total: 0, rows: "1", data }, { offset: 0, total: 0, data }, { offset: 2 ** 60, total: 0, rows: 0, data }]) {
      expect(parseArrowReply(r)).toEqual({ ok: false, message: "the kernel sent an unreadable page" });
    }
    expect(parseArrowReply({ offset: 0, total: 0, rows: 0, data: "" }).ok).toBe(false);
  });

  it("relays up to 32 MiB and refuses more, before and after decoding", () => {
    expect(parseArrowReply(reply(Buffer.alloc(MAX_ARROW_BYTES))).ok).toBe(true);
    expect(parseArrowReply(reply(Buffer.alloc(MAX_ARROW_BYTES + 1)))).toEqual({ ok: false, message: "the page is too large" });
    expect(parseArrowReply({ offset: 0, total: 0, rows: 0, data: "A".repeat(2 * MAX_ARROW_BYTES) })).toEqual({ ok: false, message: "the page is too large" });
  });
});
