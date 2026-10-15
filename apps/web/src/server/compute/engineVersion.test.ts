import fs from "node:fs";
import path from "node:path";

import { ENGINE_VERSION } from "@iara/protocol";
import { describe, expect, it } from "vitest";

describe("engine version", () => {
  it("matches the Python package the clusters install", () => {
    const pyproject = fs.readFileSync(path.resolve(import.meta.dirname, "../../../../../pyproject.toml"), "utf8");
    expect(/^version = "([^"]+)"/m.exec(pyproject)?.[1]).toBe(ENGINE_VERSION);
  });
});
