import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Command } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IaraDecision, IaraFileContext, IaraProposal } from "@/lib/iara/protocol";

import { FileSaver } from "./checkpointer";
import { answering, callStep, calling, fakeDeps, NOTEBOOK_CONTEXT, SQL_CONTEXT } from "./fakes";
import { buildIaraGraph } from "./graph";
import { userStep } from "./prompt";
import { AUTHOR_STEPS, type IaraGraphState, type Step } from "./state";

vi.mock("./tokens", () => ({
  CONTEXT_BUDGET: 200_000,
  COMPACT_AT: 0.8,
  countTokens: async (text: string) => Math.ceil(text.length / 4),
  countSteps: async () => 0,
  cutToTokens: async (text: string) => text,
}));

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "iara-graph-"));
  vi.stubEnv("IARA_STUDIO_DATA", dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

type Input = Parameters<ReturnType<typeof buildIaraGraph>["invoke"]>[0];
type Out = IaraGraphState & { __interrupt__?: { value: { proposal: IaraProposal } }[] };
const thread = { configurable: { thread_id: "t1.turn" } };

const start = (context: IaraFileContext = SQL_CONTEXT) => ({ context, history: [userStep("add a query for the orders")], summary: null, memories: [] });
const resume = (decision: IaraDecision, context: IaraFileContext): Input => new Command({ resume: decision, update: { context } });
const proposalOf = (out: Out) => out.__interrupt__?.[0]?.value.proposal;
const ok = (over = {}): IaraDecision => ({ kind: "approve", run: true, outcome: { applied: true, ran: true, status: "ok", output: "count\n7", ...over } });
const submit = (id: string, change: Record<string, unknown>) => callStep(id, "submit_change", { change, explanation: "Does it." });
/** the SQL editor holds "SELECT 1" in these tests */
const editQuery = (sql: string) => ({ action: "edit_query", edits: [{ old: "SELECT 1", new: sql }], run: true });
const types = (steps: Step[]) => steps.map((s) => s.type);

function setup(script: Parameters<typeof fakeDeps>[0]) {
  const made = fakeDeps(script);
  const graph = buildIaraGraph(made.deps, new FileSaver(path.join(dir, "checkpoints")));
  return { ...made, graph };
}

describe("buildIaraGraph", () => {
  it("asks the analyst, writes a change, waits for the user, and tells the user how it went", async () => {
    const { graph, requests, llm } = setup({
      iara: [
        calling(callStep("a1", "ask_analyst", { question: "which table has the orders?" })),
        calling(callStep("p1", "propose_change", { task: "query the orders" })),
        answering("The query is in the editor and returned 7 rows."),
      ],
      analyst: [answering("main.sales.orders(id int64), 7 rows")],
      author: [calling(submit("s1", editQuery("SELECT count(*) FROM main.sales.orders")))],
    });

    const paused = (await graph.invoke(start(), thread)) as Out;
    expect(requests.map((r) => r.agent)).toEqual(["iara", "analyst", "iara", "author"]);
    expect(llm).toHaveBeenCalledOnce();
    expect(proposalOf(paused)).toEqual({
      id: expect.any(String),
      change: editQuery("SELECT count(*) FROM main.sales.orders"),
      explanation: "Does it.",
      review: null,
      attempt: 1,
    });
    // the author was given the analyst's findings
    expect((requests[3].steps[0] as Extract<Step, { type: "user_input" }>).content[0].text).toContain("main.sales.orders(id int64), 7 rows");

    // the browser's view of the file when the user decided replaces the one the turn started with
    const after = { ...SQL_CONTEXT, query: "SELECT count(*) FROM main.sales.orders" };
    const done = (await graph.invoke(resume(ok(), after), thread)) as Out;
    expect(proposalOf(done)).toBeUndefined();
    expect(done.context).toEqual(after);
    expect(done.reply).toBe("The query is in the editor and returned 7 rows.");
    expect(types(done.history)).toEqual(["user_input", "function_call", "function_result", "function_call", "function_result", "model_output"]);
    const reportToIara = requests[4].steps.at(-1);
    expect(reportToIara).toMatchObject({ type: "function_result", call_id: "p1", result: "The change was applied.\nIt ran with status ok.\nOutput:\ncount\n7" });
    expect(done.handoff).toBeNull();
  });

  it("tells iara when the user rejects the change", async () => {
    const { graph, requests } = setup({
      iara: [calling(callStep("p1", "propose_change", { task: "query the orders" })), answering("Understood.")],
      author: [calling(submit("s1", editQuery("SELECT 1")))],
    });
    await graph.invoke(start(), thread);
    const done = (await graph.invoke(resume({ kind: "reject", feedback: "use orders_2024" }, SQL_CONTEXT), thread)) as Out;

    expect(requests.map((r) => r.agent)).toEqual(["iara", "author", "iara"]);
    expect(requests[2].steps.at(-1)).toMatchObject({ type: "function_result", call_id: "p1", result: "The user rejected the change. They said: use orders_2024" });
    expect(done.reply).toBe("Understood.");
  });

  it("answers without a handoff and ends", async () => {
    const { graph, requests } = setup({ iara: [answering("Hello!")] });
    const out = await graph.invoke(start(), thread);
    expect(requests.map((r) => r.agent)).toEqual(["iara"]);
    expect(out.reply).toBe("Hello!");
  });

  it("sends a failed run back to the author once, and asks the user again as attempt 2", async () => {
    const { graph, requests } = setup({
      iara: [calling(callStep("p1", "propose_change", { task: "add a total" })), answering("Fixed and added.")],
      author: [
        calling(submit("s1", { action: "insert_cell", kind: "python", code: "total = orders.sum()", afterCellId: "c1", run: true })),
        calling(submit("s2", { action: "edit_cell", cellId: "c2", edits: [{ old: "total = orders.sum()", new: "total = orders['id'].sum()" }], run: true })),
      ],
    });
    const first = proposalOf(await graph.invoke(start(NOTEBOOK_CONTEXT), thread) as Out)!;
    expect(first).toMatchObject({ attempt: 1, change: { action: "insert_cell" } });

    // the cell the change made is in the file the browser sends back
    const withCell: IaraFileContext = { ...NOTEBOOK_CONTEXT, cells: [...NOTEBOOK_CONTEXT.cells, { id: "c2", kind: "python", code: "total = orders.sum()", status: "error" }] } as IaraFileContext;
    const failed = ok({ cellId: "c2", status: "error", error: "NameError: orders", output: "" });
    const second = proposalOf((await graph.invoke(resume(failed, withCell), thread)) as Out)!;

    expect(requests.map((r) => r.agent)).toEqual(["iara", "author", "author"]);
    const fix = (requests[2].steps[0] as Extract<Step, { type: "user_input" }>).content[0].text;
    expect(fix).toContain("It was refused: It was applied as cell c2 and ran with an error:\nNameError: orders");
    expect(fix).toContain("cell c2");
    expect(second).toMatchObject({ attempt: 2, change: { action: "edit_cell", cellId: "c2" } });
    expect(second.id).not.toBe(first.id);

    const done = (await graph.invoke(resume(ok({ cellId: "c2" }), withCell), thread)) as Out;
    expect(proposalOf(done)).toBeUndefined();
    expect(requests.map((r) => r.agent)).toEqual(["iara", "author", "author", "iara"]);
    expect(requests[3].steps.at(-1)).toMatchObject({ type: "function_result", call_id: "p1", result: expect.stringContaining("The change was applied as cell c2.") });
    expect(done.fixes).toBe(1);
  });

  it("reports a run that keeps failing after the fixes are used", async () => {
    const edit = (id: string) => calling(submit(id, { action: "edit_cell", cellId: "c1", edits: [{ old: "x = 1", new: "boom()" }], run: true }));
    const { graph, requests } = setup({
      iara: [calling(callStep("p1", "propose_change", { task: "break it" })), answering("It keeps failing.")],
      author: [edit("s1"), edit("s2"), edit("s3")],
    });
    const failed = ok({ cellId: "c1", status: "error", error: "boom" });
    await graph.invoke(start(NOTEBOOK_CONTEXT), thread);
    await graph.invoke(resume(failed, NOTEBOOK_CONTEXT), thread);
    await graph.invoke(resume(failed, NOTEBOOK_CONTEXT), thread);
    const done = (await graph.invoke(resume(failed, NOTEBOOK_CONTEXT), thread)) as Out;

    expect(requests.map((r) => r.agent)).toEqual(["iara", "author", "author", "author", "iara"]);
    expect(requests[4].steps.at(-1)).toMatchObject({ result: expect.stringContaining("It ran with status error.") });
    expect(done.reply).toBe("It keeps failing.");
  });

  it("goes back to iara with the failure when the author writes no change", async () => {
    const { graph, requests } = setup({
      iara: [calling(callStep("p1", "propose_change", { task: "do something" })), answering("I could not write it.")],
      author: Array.from({ length: AUTHOR_STEPS }, () => answering("hmm")),
    });
    const out = await graph.invoke(start(), thread);

    expect(proposalOf(out as Out)).toBeUndefined();
    expect(requests.at(-1)!.agent).toBe("iara");
    expect(requests.at(-1)!.steps.at(-1)).toMatchObject({ type: "function_result", call_id: "p1", result: "The author could not write the change: no change submitted" });
    expect(out.reply).toBe("I could not write it.");
  });

  it("sends a change the reviewer refuses back to the author", async () => {
    const { graph, requests, llm } = setup({
      iara: [calling(callStep("p1", "propose_change", { task: "count orders" }))],
      author: [calling(submit("s1", editQuery("SELECT 1"))), calling(submit("s2", editQuery("SELECT count(*) FROM main.sales.orders")))],
    });
    llm.mockResolvedValueOnce({ ok: false, notes: "It does not count the orders." });
    const paused = (await graph.invoke(start(), thread)) as Out;

    expect(requests.map((r) => r.agent)).toEqual(["iara", "author", "author"]);
    expect((requests[2].steps[0] as Extract<Step, { type: "user_input" }>).content[0].text).toContain("It was refused: It does not count the orders.");
    expect(proposalOf(paused)).toMatchObject({ change: { edits: [{ old: "SELECT 1", new: "SELECT count(*) FROM main.sales.orders" }] }, review: null });
    expect(paused.reviews).toBe(1);
  });

  it("resumes on a graph built again, as after a restart", async () => {
    const script = {
      iara: [calling(callStep("p1", "propose_change", { task: "query" })), answering("Done.")],
      author: [calling(submit("s1", editQuery("SELECT 1")))],
    };
    const first = fakeDeps(script);
    await buildIaraGraph(first.deps, new FileSaver(path.join(dir, "checkpoints"))).invoke(start(), thread);

    const second = fakeDeps(script);
    const done = (await buildIaraGraph(second.deps, new FileSaver(path.join(dir, "checkpoints"))).invoke(resume(ok(), SQL_CONTEXT), thread)) as Out;
    expect(done.reply).toBe("Done.");
    expect(second.requests.map((r) => r.agent)).toEqual(["iara"]);
  });
});
