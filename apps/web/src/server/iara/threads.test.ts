import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IaraProposal } from "@/lib/iara/protocol";

import { LOCAL_USER, type StudioUser } from "../auth/access";
import { iaraDir } from "./paths";
import { createThread, listThreads, readThread, removeThread, saveThread, threadView } from "./threads";
import { CONTEXT_BUDGET } from "./tokens";

let dir: string;
const ana: StudioUser = { email: "ana@example.com", name: "Ana", admin: false };
const bob: StudioUser = { email: "bob@example.com", name: "Bob", admin: false };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "iara-threads-"));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

const hashOf = (key: string) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 24);

describe("iaraDir", () => {
  it("is one folder per user, from the lowercased email, or from local when there is none", () => {
    expect(iaraDir(ana, dir)).toBe(path.join(dir, "iara", "users", hashOf("ana@example.com")));
    expect(iaraDir({ ...ana, email: "ANA@example.com" }, dir)).toBe(iaraDir(ana, dir));
    expect(iaraDir(LOCAL_USER, dir)).toBe(path.join(dir, "iara", "users", hashOf("local")));
  });
});

describe("createThread and readThread", () => {
  it("saves an empty conversation and reads it back", async () => {
    const t = await createThread(ana, "file-1", "sql", dir);
    expect(t).toMatchObject({
      fileId: "file-1",
      surface: "sql",
      title: "",
      messages: [],
      history: [],
      summary: null,
      pending: null,
      usage: { context: 0, budget: CONTEXT_BUDGET, turnInput: 0, turnOutput: 0 },
    });
    expect(await readThread(ana, t.id, dir)).toEqual(t);
  });

  it("refuses an id that is not a safe file name, and an id with no conversation", async () => {
    await expect(readThread(ana, "../secret", dir)).rejects.toThrow("there is no such conversation");
    await expect(readThread(ana, "missing", dir)).rejects.toThrow("there is no such conversation");
  });

  it("does not let one user read another user's conversation", async () => {
    const mine = await createThread(ana, "file-1", "notebook", dir);
    await expect(readThread(bob, mine.id, dir)).rejects.toThrow("there is no such conversation");
    expect(await listThreads(bob, null, dir)).toEqual([]);
  });
});

describe("saveThread", () => {
  it("stamps the time and keeps what the conversation holds", async () => {
    const t = await createThread(ana, "file-1", "notebook", dir);
    const before = Date.now();
    t.title = "Sales by month";
    t.messages.push({ id: "m1", role: "user", text: "hi", at: before });
    const saved = await saveThread(ana, t, dir);
    expect(saved.updated).toBeGreaterThanOrEqual(before);
    const back = await readThread(ana, t.id, dir);
    expect(back.title).toBe("Sales by month");
    expect(back.messages).toHaveLength(1);
  });
});

describe("listThreads", () => {
  it("lists summaries newest first, of one file when given", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
    const old = await createThread(ana, "file-1", "notebook", dir);
    vi.setSystemTime(2_000);
    const sql = await createThread(ana, "file-2", "sql", dir);
    vi.setSystemTime(3_000);
    const newest = await createThread(ana, "file-1", "notebook", dir);

    const all = await listThreads(ana, null, dir);
    expect(all.map((t) => t.id)).toEqual([newest.id, sql.id, old.id]);
    expect(Object.keys(all[0]).sort()).toEqual(["fileId", "id", "surface", "title", "updated"]);
    expect((await listThreads(ana, "file-1", dir)).map((t) => t.id)).toEqual([newest.id, old.id]);
  });

  it("skips a file it cannot read", async () => {
    const t = await createThread(ana, "file-1", "notebook", dir);
    fs.writeFileSync(path.join(iaraDir(ana, dir), "threads", "broken.json"), "{ nope");
    expect((await listThreads(ana, null, dir)).map((x) => x.id)).toEqual([t.id]);
  });
});

describe("removeThread", () => {
  it("deletes the conversation; a missing one is fine, an invalid id is not", async () => {
    const t = await createThread(ana, "file-1", "notebook", dir);
    await removeThread(ana, t.id, dir);
    await expect(readThread(ana, t.id, dir)).rejects.toThrow("there is no such conversation");
    await expect(removeThread(ana, t.id, dir)).resolves.toBeUndefined();
    await expect(removeThread(ana, "../x", dir)).rejects.toThrow("there is no such conversation");
  });
});

describe("threadView", () => {
  it("shows the messages, the waiting proposal and the usage, not the model's history", async () => {
    const t = await createThread(ana, "file-1", "sql", dir);
    const proposal: IaraProposal = {
      id: "p1",
      change: { action: "edit_query", edits: [{ old: "", new: "select 1" }], run: true },
      explanation: "a query",
      review: null,
      attempt: 1,
    };
    t.pending = { turn: "turn-1", proposal };
    t.history = [{ type: "user_input", content: [{ type: "text", text: "hi" }] }];
    expect(threadView(t)).toEqual({
      id: t.id,
      fileId: "file-1",
      surface: "sql",
      title: "",
      updated: t.updated,
      messages: [],
      pending: proposal,
      usage: t.usage,
    });
  });
});
