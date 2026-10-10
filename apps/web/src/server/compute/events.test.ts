import path from "node:path";

import { describe, expect, it } from "vitest";

import { ClusterEventLog, type EventFiles, KEEP_EVENTS } from "./events";

/** Files in memory, keyed by path (the disk is injected in the Studio). */
function memory() {
  const files = new Map<string, string>();
  const io: EventFiles = {
    append: (file, text) => void files.set(file, (files.get(file) ?? "") + text),
    read: (file) => files.get(file) ?? null,
    write: (file, text) => void files.set(file, text),
    remove: (file) => void files.delete(file),
  };
  return { files, io };
}

function setup() {
  const { files, io } = memory();
  const log = new ClusterEventLog({ dir: "logs", files: io });
  return { files, log };
}

const file1 = path.join("logs", "c-1.jsonl");

const linesOf = (files: Map<string, string>, file: string) => (files.get(file) ?? "").split("\n").filter(Boolean);

describe("ClusterEventLog", () => {
  it("lists a cluster's events newest first, and only its own", () => {
    const { log } = setup();
    log.record("c-1", { at: 1, kind: "created", message: "first" });
    log.record("c-2", { at: 2, kind: "start", message: "other" });
    log.record("c-1", { at: 3, kind: "start", message: "second" });
    expect(log.list("c-1")).toEqual([
      { at: 3, kind: "start", message: "second" },
      { at: 1, kind: "created", message: "first" },
    ]);
    expect(log.list("nothing")).toEqual([]);
  });

  it("appends one JSON line per event in the cluster's file", () => {
    const { files, log } = setup();
    log.record("c-1", { at: 1, kind: "error", message: "boom" });
    expect(linesOf(files, file1)).toEqual([JSON.stringify({ at: 1, kind: "error", message: "boom" })]);
  });

  it("shows the last 500 events, and compacts the file once it holds twice as many", () => {
    const { files, log } = setup();
    for (let i = 1; i <= 1100; i++) log.record("c-1", { at: i, kind: "running", message: `m${i}` });
    const shown = log.list("c-1");
    expect(shown).toHaveLength(KEEP_EVENTS);
    expect(shown[0].at).toBe(1100);
    expect(shown[KEEP_EVENTS - 1].at).toBe(601);
    // compacted at 1000 lines to 500, then 100 more
    expect(linesOf(files, file1)).toHaveLength(600);
  });

  it("compacts a file that grew past the limit in an earlier process", () => {
    const { files, io } = memory();
    const old = Array.from({ length: 1200 }, (_, i) => JSON.stringify({ at: i, kind: "running", message: "x" }));
    files.set(file1, old.join("\n") + "\n");
    const log = new ClusterEventLog({ dir: "logs", files: io });
    log.record("c-1", { at: 5000, kind: "terminated", message: "end" });
    expect(linesOf(files, file1)).toHaveLength(KEEP_EVENTS);
    expect(log.list("c-1")[0]).toEqual({ at: 5000, kind: "terminated", message: "end" });
  });

  it("skips torn or foreign lines", () => {
    const { files, log } = setup();
    files.set(
      file1,
      [
        JSON.stringify({ at: 1, kind: "created", message: "ok" }),
        '{"at": 2, "kind"',
        "null",
        JSON.stringify({ at: 3, kind: "unknown-kind", message: "bad" }),
        JSON.stringify({ at: 4, kind: "error", message: "ok too" }),
      ].join("\n") + "\n",
    );
    expect(log.list("c-1").map((e) => e.message)).toEqual(["ok too", "ok"]);
  });

  it("caps long messages", () => {
    const { log } = setup();
    log.record("c-1", { at: 1, kind: "error", message: "x".repeat(5000) });
    expect(log.list("c-1")[0].message).toHaveLength(1000);
  });

  it("forgets a cluster's log", () => {
    const { files, log } = setup();
    log.record("c-1", { at: 1, kind: "created", message: "a" });
    log.forget("c-1");
    expect(files.has(file1)).toBe(false);
    expect(log.list("c-1")).toEqual([]);
    log.forget("c-1"); // already gone: nothing to do
  });

  it("refuses ids that are not plain names (they become file names)", () => {
    const { log } = setup();
    expect(() => log.list("../secrets")).toThrow(/invalid cluster id/);
    expect(() => log.record("a/b", { at: 1, kind: "created", message: "" })).toThrow(/invalid cluster id/);
  });
});
