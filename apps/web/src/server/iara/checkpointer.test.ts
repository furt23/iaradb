import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Annotation, Command, END, interrupt, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileSaver } from "./checkpointer";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "iara-checkpoints-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const State = Annotation.Root({
  log: Annotation<string[]>({ reducer: (all, more) => all.concat(more), default: () => [] }),
  answer: Annotation<string>(),
});

/** a -> ask (pauses for the user) -> b */
function graph(saver: MemorySaver) {
  return new StateGraph(State)
    .addNode("a", () => ({ log: ["a"] }))
    .addNode("ask", () => ({ answer: interrupt({ q: 1 }) as string, log: ["ask"] }))
    .addNode("b", () => ({ log: ["b"] }))
    .addEdge(START, "a")
    .addEdge("a", "ask")
    .addEdge("ask", "b")
    .addEdge("b", END)
    .compile({ checkpointer: saver });
}

const thread = { configurable: { thread_id: "t1.x" } };
const file = () => path.join(dir, "t1.x.json");

describe("FileSaver", () => {
  it("resumes a paused run on a new saver, as after a restart", async () => {
    const paused = (await graph(new FileSaver(dir)).invoke({ log: ["start"] }, thread)) as { __interrupt__?: { value: unknown }[] };
    expect(paused.__interrupt__?.[0]?.value).toEqual({ q: 1 });

    const out = await graph(new FileSaver(dir)).invoke(new Command({ resume: "yes" }), thread);
    expect(out.answer).toBe("yes");
    expect(out.log).toEqual(["start", "a", "ask", "b"]);
  });

  it("keeps one checkpoint per namespace and only the writes of that one", async () => {
    await graph(new FileSaver(dir)).invoke({ log: [] }, thread);
    await graph(new FileSaver(dir)).invoke(new Command({ resume: "yes" }), thread);

    const saved = JSON.parse(fs.readFileSync(file(), "utf8")) as { storage: Record<string, object>; writes: Record<string, unknown> };
    for (const byId of Object.values(saved.storage)) expect(Object.keys(byId)).toHaveLength(1);
    const kept = Object.entries(saved.storage).flatMap(([ns, byId]) => Object.keys(byId).map((cp) => JSON.stringify(["t1.x", ns, cp])));
    for (const key of Object.keys(saved.writes)) expect(kept).toContain(key);

    // the same run on a MemorySaver keeps every step
    const memory = new MemorySaver();
    await graph(memory).invoke({ log: [] }, thread);
    await graph(memory).invoke(new Command({ resume: "yes" }), thread);
    expect(Object.keys(memory.storage["t1.x"][""]).length).toBeGreaterThan(1);
  });

  it("deleteThread removes the file and the thread", async () => {
    const saver = new FileSaver(dir);
    await graph(saver).invoke({ log: [] }, thread);
    expect(fs.existsSync(file())).toBe(true);

    await saver.deleteThread("t1.x");
    expect(fs.existsSync(file())).toBe(false);
    expect(await new FileSaver(dir).getTuple(thread)).toBeUndefined();
    expect(await saver.getTuple(thread)).toBeUndefined();
  });

  it("refuses thread ids that are not safe file names", async () => {
    const saver = new FileSaver(dir);
    for (const id of ["../x", "a/b", "a\\b", "a..b", "", "a".repeat(161)]) {
      await expect(saver.getTuple({ configurable: { thread_id: id } })).rejects.toThrow(/invalid thread id/);
      await expect(saver.deleteThread(id)).rejects.toThrow(/invalid thread id/);
      await expect(graph(saver).invoke({ log: [] }, { configurable: { thread_id: id } })).rejects.toThrow(/invalid thread id/);
    }
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
