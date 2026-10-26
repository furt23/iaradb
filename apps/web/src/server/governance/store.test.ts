import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StudioUser } from "../auth/access";
import { DEFAULT_GRANTS } from "./grants";
import { grantsFile, readGrants, userAllow, writeGrants } from "./store";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "iara-grants-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readGrants and writeGrants", () => {
  it("grants the defaults until a file is saved", () => {
    expect(readGrants(dir)).toEqual(DEFAULT_GRANTS);
  });

  it("writes a file that reads back, with nothing left beside it", () => {
    writeGrants([{ to: "ana@example.com", on: "main.sales" }, { to: "viewers", on: "*" }], dir);
    expect(readGrants(dir)).toEqual([{ to: "ana@example.com", on: "main.sales" }, { to: "viewers", on: "*" }]);
    expect(fs.readdirSync(dir)).toEqual(["grants.json"]);
    expect(JSON.parse(fs.readFileSync(grantsFile(dir), "utf8"))).toEqual({
      grants: [
        { to: "ana@example.com", on: "main.sales" },
        { to: "viewers", on: "*" },
      ],
    });
  });

  it("refuses to save a grant that is not valid", () => {
    expect(() => writeGrants([{ to: "editors", on: "a.b.c.d" }], dir)).toThrow(/is not \*/);
    expect(fs.existsSync(grantsFile(dir))).toBe(false);
  });

  it("throws on a file that is not JSON, has no list, or holds a bad grant: never a silent allow", () => {
    fs.writeFileSync(grantsFile(dir), "{ nope");
    expect(() => readGrants(dir)).toThrow(/is not valid JSON/);
    fs.writeFileSync(grantsFile(dir), "null");
    expect(() => readGrants(dir)).toThrow(/has no grants list/);
    fs.writeFileSync(grantsFile(dir), JSON.stringify({ grants: [{ to: "editors", on: "a..b" }] }));
    expect(() => readGrants(dir)).toThrow(/a\.\.b is not/);
  });
});

describe("userAllow", () => {
  const ana: StudioUser = { email: "ana@example.com", name: "Ana", admin: false };

  it("is what the saved grants allow the user, read from the Studio's data folder", () => {
    vi.stubEnv("IARA_STUDIO_DATA", dir);
    expect(userAllow(ana)).toEqual(["*"]);
    writeGrants([{ to: "ana@example.com", on: "main" }], dir);
    expect(userAllow(ana)).toEqual(["main"]);
    expect(userAllow({ ...ana, admin: true })).toBeNull();
  });
});
