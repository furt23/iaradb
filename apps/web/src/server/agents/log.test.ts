import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentLogEntry } from "@/lib/agents/types";

import { appendLog, deleteLog, listLog, rateLog } from "./log";

let root: string;
const ID = "abcd1234";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "iara-log-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

let next = 0;
const asked = (question: string, queries: string[] = ["SELECT 1"]) => ({ id: `m${next++}`, at: Date.now(), user: "ana@example.com", threadId: "t1", question, answer: "an answer", queries, ms: 1200 });

describe("appendLog and listLog", () => {
  it("keeps the newest question first, with no rating yet", async () => {
    expect(await listLog(ID, root)).toEqual([]);
    const one = await appendLog(ID, asked("one"), root);
    const two = await appendLog(ID, asked("two"), root);
    expect(one).toMatchObject({ question: "one", answer: "an answer", queries: ["SELECT 1"], rating: null, note: "", user: "ana@example.com", threadId: "t1" });
    expect(one).toMatchObject({ id: expect.stringMatching(/^m\d+$/), ms: 1200 });
    expect((await listLog(ID, root)).map((e) => e.id)).toEqual([two.id, one.id]);
  });

  it("cuts a question, an answer and its queries to their sizes", async () => {
    const e = await appendLog(ID, { ...asked("q".repeat(5000), Array.from({ length: 25 }, () => "s".repeat(21_000))), answer: "a".repeat(21_000) }, root);
    expect(e.question).toHaveLength(4000);
    expect(e.answer).toHaveLength(20_000);
    expect(e.queries).toHaveLength(20);
    expect(e.queries[0]).toHaveLength(20_000);
  });

  it("keeps the newest 1000 entries", async () => {
    const old = Array.from({ length: 1000 }, (_, i) => ({ id: `e${i}`, at: i, user: "", threadId: "", question: `q${i}`, answer: "", queries: [], ms: 0, rating: null, note: "" }));
    fs.mkdirSync(path.join(root, "agents", ID), { recursive: true });
    fs.writeFileSync(path.join(root, "agents", ID, "log.json"), JSON.stringify(old));
    const added = await appendLog(ID, asked("new"), root);
    const list = await listLog(ID, root);
    expect(list).toHaveLength(1000);
    expect(list[0].id).toBe(added.id);
    expect(list[999].id).toBe("e998");
  });

  it("keeps every question when many are asked at once", async () => {
    const added = await Promise.all(Array.from({ length: 20 }, (_, i) => appendLog(ID, asked(`q${i}`), root)));
    const list = await listLog(ID, root);
    expect(list).toHaveLength(20);
    expect(new Set(list.map((e: AgentLogEntry) => e.id))).toEqual(new Set(added.map((e) => e.id)));
  });

  it("refuses an agent id that is not one", async () => {
    await expect(appendLog("../x", asked("x"), root)).rejects.toThrow("there is no such agent");
    await expect(listLog("NO", root)).rejects.toThrow("there is no such agent");
  });
});

describe("rateLog", () => {
  it("sets the rating and the trimmed note, and clears them", async () => {
    const e = await appendLog(ID, asked("q"), root);
    const rated = await rateLog(ID, e.id, "bad", "  wrong table  ", root);
    expect(rated).toEqual({ ...e, rating: "bad", note: "wrong table" });
    expect(await listLog(ID, root)).toEqual([rated]);
    // a rating with no note (from the chat) keeps the reviewer's note
    expect(await rateLog(ID, e.id, "good", undefined, root)).toEqual({ ...e, rating: "good", note: "wrong table" });
    expect(await rateLog(ID, e.id, null, "", root)).toEqual(e);
  });

  it("cuts a note to 2000 characters", async () => {
    const e = await appendLog(ID, asked("q"), root);
    expect((await rateLog(ID, e.id, "good", "n".repeat(2500), root)).note).toHaveLength(2000);
  });

  it("refuses an entry that is not in the log, and a rating that is not one", async () => {
    const e = await appendLog(ID, asked("q"), root);
    await expect(rateLog(ID, "missing", "good", "", root)).rejects.toThrow("there is no such question in the log");
    await expect(rateLog(ID, e.id, "meh" as never, "", root)).rejects.toThrow(/a rating is good, bad or none/);
  });
});

describe("deleteLog", () => {
  it("removes the agent's log; one that is not there is fine", async () => {
    await appendLog(ID, asked("q"), root);
    await deleteLog(ID, root);
    expect(fs.existsSync(path.join(root, "agents", ID))).toBe(false);
    expect(await listLog(ID, root)).toEqual([]);
    await expect(deleteLog(ID, root)).resolves.toBeUndefined();
    await expect(deleteLog("../x", root)).rejects.toThrow("there is no such agent");
  });
});
