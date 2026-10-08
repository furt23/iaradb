import { describe, expect, it } from "vitest";

import { parseEvents } from "@/lib/sse";

import { parseStatus } from "./git/status";
import { normalizeRelative, notebookKernel, parseKernelKey } from "./kernel/keys";
import { parseMessage } from "./kernel/wire";
import { encodeEvent } from "./stream/sse";

describe("kernel wire messages", () => {
  it("parses results, errors and events", () => {
    expect(parseMessage('{"id":3,"result":{"ok":true}}')).toEqual({ kind: "result", id: 3, result: { ok: true } });
    expect(parseMessage('{"id":4,"error":{"type":"KeyError","message":"x"}}')).toEqual({ kind: "error", id: 4, error: { type: "KeyError", message: "x" } });
    expect(parseMessage('{"event":"cell.state","request":5,"data":{"cell_id":"a"}}')).toEqual({
      kind: "event",
      event: "cell.state",
      request: 5,
      data: { cell_id: "a" },
    });
  });

  it("ignores garbage", () => {
    expect(parseMessage("")).toBeNull();
    expect(parseMessage("not json")).toBeNull();
    expect(parseMessage('{"neither":1}')).toBeNull();
  });
});

describe("server-sent events", () => {
  it("round-trips through the encoder and the client parser", () => {
    const wire = encodeEvent("progress", { q: [1, 2] }) + encodeEvent("done", { ran: ["a"] }) + "event: partial\ndata: {";
    const { events, rest } = parseEvents(wire);
    expect(events).toEqual([
      { event: "progress", data: { q: [1, 2] } },
      { event: "done", data: { ran: ["a"] } },
    ]);
    expect(rest).toBe("event: partial\ndata: {");
  });
});

describe("workspace paths and kernel keys", () => {
  it("normalizes relative paths", () => {
    expect(normalizeRelative("notebooks\\a.py")).toBe("notebooks/a.py");
    expect(normalizeRelative("./x//y.py")).toBe("x/y.py");
  });

  it("refuses escapes", () => {
    expect(() => normalizeRelative("../etc/passwd")).toThrow();
    expect(() => normalizeRelative("a/../../b")).toThrow();
    expect(() => normalizeRelative("C:/Windows")).toThrow();
  });

  it("validates kernel keys", () => {
    expect(parseKernelKey("workspace")).toBe("workspace");
    expect(parseKernelKey("notebook:nb\\a.py")).toBe(notebookKernel("nb/a.py"));
    expect(() => parseKernelKey("rm -rf")).toThrow();
  });
});

describe("git status parsing", () => {
  it("reads branch, tracking and files", () => {
    const out = ["## main...origin/main [ahead 2, behind 1]", " M notebooks/a.py", "?? data/new.csv", "R  b.py", "a.py", ""].join("\0");
    expect(parseStatus(out)).toEqual({
      branch: "main",
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
      files: [
        { index: " ", worktree: "M", path: "notebooks/a.py" },
        { index: "?", worktree: "?", path: "data/new.csv" },
        { index: "R", worktree: " ", path: "b.py", from: "a.py" },
      ],
    });
  });

  it("handles a fresh repository", () => {
    expect(parseStatus("## No commits yet on main\0").branch).toBe("main");
  });
});
