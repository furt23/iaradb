import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createToken, listTokens, revokeToken, userForToken } from "./tokens";

const env = { IARA_ALLOWED_EMAILS: "a@x.com", IARA_ADMIN_EMAILS: "a@x.com", IARA_VIEWER_EMAILS: "v@x.com" };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "iara-tokens-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("personal access tokens", () => {
  it("creates a token that acts as its owner, and stores only its hash", () => {
    const { id, token } = createToken("A@x.com", "laptop", dir);
    expect(token).toMatch(/^iara_[A-Za-z0-9_-]{43}$/);
    expect(fs.readFileSync(path.join(dir, "tokens.json"), "utf8")).not.toContain(token);
    expect(userForToken(token, dir, env)).toEqual({ email: "a@x.com", name: "a@x.com", admin: true });
    expect(listTokens("a@x.com", dir)).toEqual([expect.objectContaining({ id, name: "laptop" })]);
    expect(listTokens("b@x.com", dir)).toEqual([]);
  });

  it("records when a token was last used", () => {
    const { id, token } = createToken("a@x.com", "ci", dir);
    expect(listTokens("a@x.com", dir)[0].lastUsedAt).toBeUndefined();
    userForToken(token, dir, env);
    expect(listTokens("a@x.com", dir).find((t) => t.id === id)?.lastUsedAt).toEqual(expect.any(Number));
  });

  it("refuses an unknown token", () => {
    createToken("a@x.com", "ci", dir);
    expect(userForToken("iara_nope", dir, env)).toBeNull();
  });

  it("refuses a viewer's token", () => {
    const { token } = createToken("v@x.com", "viewer", dir);
    expect(userForToken(token, dir, env)).toBeNull();
  });

  it("refuses a token once its email is removed from the allowlist", () => {
    const { token } = createToken("a@x.com", "ci", dir);
    expect(userForToken(token, dir, { IARA_ALLOWED_EMAILS: "b@x.com" })).toBeNull();
  });

  it("revokes only the owner's token", () => {
    const { id, token } = createToken("a@x.com", "ci", dir);
    expect(() => revokeToken("b@x.com", id, dir)).toThrow("there is no such token");
    revokeToken("a@x.com", id, dir);
    expect(userForToken(token, dir, env)).toBeNull();
    expect(listTokens("a@x.com", dir)).toEqual([]);
  });
});
