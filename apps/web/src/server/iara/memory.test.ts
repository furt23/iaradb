import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StudioUser } from "../auth/access";
import { addMemory, listMemories, MAX_MEMORIES, MAX_MEMORY_TEXT, removeMemory, updateMemory } from "./memory";

let dir: string;
const ana: StudioUser = { email: "ana@example.com", name: "Ana", admin: false };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "iara-memory-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("listMemories", () => {
  it("is empty until Iara saves something", async () => {
    expect(await listMemories(ana, dir)).toEqual([]);
  });
});

describe("addMemory", () => {
  it("saves the trimmed text with an id and the time, oldest first", async () => {
    const before = Date.now();
    const first = await addMemory(ana, "  Ana works on sales  ", dir);
    const second = await addMemory(ana, "Ana prefers SQL", dir);
    expect(first).toMatchObject({ text: "Ana works on sales" });
    expect(first.created).toBeGreaterThanOrEqual(before);
    expect(first.id).not.toBe(second.id);
    expect((await listMemories(ana, dir)).map((m) => m.text)).toEqual(["Ana works on sales", "Ana prefers SQL"]);
  });

  it("returns the saved memory when the same text comes again, ignoring case and surrounding spaces", async () => {
    const first = await addMemory(ana, "Ana works on sales", dir);
    expect(await addMemory(ana, "  ana WORKS on sales ", dir)).toEqual(first);
    expect(await listMemories(ana, dir)).toHaveLength(1);
  });

  it("refuses empty text and text over 500 characters", async () => {
    await expect(addMemory(ana, "   ", dir)).rejects.toThrow("a memory is 1 to 500 characters");
    await expect(addMemory(ana, "x".repeat(MAX_MEMORY_TEXT + 1), dir)).rejects.toThrow("a memory is 1 to 500 characters");
    expect(await listMemories(ana, dir)).toEqual([]);
  });

  it("keeps every save when they run at once", async () => {
    await Promise.all(["a", "b", "c"].map((text) => addMemory(ana, text, dir)));
    expect((await listMemories(ana, dir)).map((m) => m.text).sort()).toEqual(["a", "b", "c"]);
  });

  it("refuses a new memory past the limit, but still returns a repeat", async () => {
    for (let i = 0; i < MAX_MEMORIES; i++) await addMemory(ana, `fact ${i}`, dir);
    await expect(addMemory(ana, "one more", dir)).rejects.toThrow("Iara remembers at most 100 things: forget one first");
    expect(await addMemory(ana, "fact 7", dir)).toMatchObject({ text: "fact 7" });
  });
});

describe("updateMemory", () => {
  it("changes the text and keeps the id and the time", async () => {
    const saved = await addMemory(ana, "Ana works on sales", dir);
    const changed = await updateMemory(ana, saved.id, "Ana works on marketing", dir);
    expect(changed).toEqual({ ...saved, text: "Ana works on marketing" });
    expect(await listMemories(ana, dir)).toEqual([changed]);
  });

  it("throws on an unknown id or a bad text", async () => {
    const saved = await addMemory(ana, "Ana works on sales", dir);
    await expect(updateMemory(ana, "nope", "x", dir)).rejects.toThrow("there is no such memory");
    await expect(updateMemory(ana, saved.id, "", dir)).rejects.toThrow("a memory is 1 to 500 characters");
  });
});

describe("removeMemory", () => {
  it("forgets the memory and returns it, or null when there is none", async () => {
    const saved = await addMemory(ana, "Ana works on sales", dir);
    expect(await removeMemory(ana, saved.id, dir)).toEqual(saved);
    expect(await listMemories(ana, dir)).toEqual([]);
    expect(await removeMemory(ana, saved.id, dir)).toBeNull();
  });
});
