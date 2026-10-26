import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";

import type { IaraChange } from "@/lib/iara/protocol";

import { answering, callStep, calling, fakeDeps, NOTEBOOK_CONTEXT } from "../fakes";
import { AUTHOR_STEPS, MAX_STEPS, type IaraGraphState, type Step } from "../state";
import { authorNode } from "./author";

vi.mock("../tokens", () => ({
  countTokens: async (text: string) => Math.ceil(text.length / 4),
  countSteps: async () => 0,
  cutToTokens: async (text: string) => text,
}));

const state = (over: Partial<IaraGraphState> = {}): IaraGraphState =>
  ({
    context: NOTEBOOK_CONTEXT,
    handoff: { callId: "h1", name: "propose_change", request: "add a cell that counts the orders" },
    findings: [],
    draft: null,
    refusal: null,
    steps: 2,
    usage: { input: 5, output: 1 },
    ...over,
  }) as IaraGraphState;

const config = () => {
  const writer = vi.fn();
  return { config: { writer } as unknown as LangGraphRunnableConfig, writer };
};

const change: IaraChange = { action: "insert_cell", kind: "sql", code: "SELECT count(*) FROM main.sales.orders", afterCellId: "c1", run: true };
const submit = (id: string, args: unknown) => callStep(id, "submit_change", args as Record<string, unknown>);
const good = (id = "s1") => calling(submit(id, { change, explanation: "Counts the orders." }));

describe("authorNode", () => {
  it("looks at the tables, then submits the change as the draft", async () => {
    const { deps, requests } = fakeDeps({ author: [calling(callStep("c1", "describe_table", { name: "main.sales.orders" })), good()] });
    const { config: c, writer } = config();
    const out = await authorNode(deps)(state({ findings: ["orders is main.sales.orders"] }), c);

    expect(out).toEqual({ draft: { change, explanation: "Counts the orders." }, refusal: null, proposal: null, steps: 4, usage: { input: 5 + 20, output: 1 + 4 } });
    expect(writer.mock.calls.map(([e]) => e)).toEqual([
      { type: "agent", agent: "author" },
      { type: "tool", use: { agent: "author", tool: "describe_table", target: "main.sales.orders" } },
    ]);
    const first = (requests[0].steps[0] as Extract<Step, { type: "user_input" }>).content[0].text;
    expect(first).toContain("Task: add a cell that counts the orders");
    expect(first).toContain("What the analyst found (in this conversation):\norders is main.sales.orders");
    expect(first).toContain("The open file:\nNotebook n.ipynb");
    expect(requests[0].tools?.map((t) => t.name)).toEqual(["list_tables", "describe_table", "read_file", "submit_change"]);
    expect(requests[1].steps.at(-1)).toMatchObject({ type: "function_result", call_id: "c1", name: "describe_table" });
  });

  it("tells the model what was wrong with a submission and takes the next one", async () => {
    const bad = calling(submit("s1", { change: { action: "insert_cell", kind: "sql" }, explanation: "x" }));
    const { deps, requests } = fakeDeps({ author: [bad, good("s2")] });
    const out = await authorNode(deps)(state(), config().config);

    expect(out.draft).toEqual({ change, explanation: "Counts the orders." });
    expect(requests[1].steps.at(-1)).toMatchObject({ type: "function_result", call_id: "s1", is_error: true, result: expect.stringContaining("code") });
    expect(out.steps).toBe(4);
  });

  it("refuses edits that do not fit the file, and takes the next valid submission", async () => {
    const misfit = calling(submit("s1", { change: { action: "edit_cell", cellId: "c1", edits: [{ old: "y = 9", new: "y = 8" }], run: false }, explanation: "x" }));
    const fits = calling(submit("s2", { change: { action: "edit_cell", cellId: "c1", edits: [{ old: "x = 1", new: "x = 2" }], run: false }, explanation: "Sets x." }));
    const { deps, requests } = fakeDeps({ author: [misfit, fits] });
    const out = await authorNode(deps)(state(), config().config);

    expect(requests[1].steps.at(-1)).toMatchObject({ type: "function_result", call_id: "s1", is_error: true, result: "old was not found in the code; copy it exactly from the current code" });
    expect(out.draft).toEqual({ change: { action: "edit_cell", cellId: "c1", edits: [{ old: "x = 1", new: "x = 2" }], run: false }, explanation: "Sets x." });
  });

  it("rejects an empty explanation", async () => {
    const { deps, requests } = fakeDeps({ author: [calling(submit("s1", { change, explanation: "  " })), good("s2")] });
    await authorNode(deps)(state(), config().config);
    expect(requests[1].steps.at(-1)).toMatchObject({ is_error: true, result: expect.stringContaining("explanation") });
  });

  it("asks again when the reply has no call", async () => {
    const { deps, requests } = fakeDeps({ author: [answering("Here is the change: ..."), good()] });
    const out = await authorNode(deps)(state(), config().config);
    expect(out.draft).toBeTruthy();
    expect(requests[1].steps.at(-1)).toMatchObject({ type: "user_input", content: [{ text: "Call submit_change with the change." }] });
  });

  it("does not run a tool it was not given", async () => {
    const { deps, requests } = fakeDeps({ author: [calling(callStep("c1", "run_sql", { sql: "DROP TABLE x" })), good()] });
    await authorNode(deps)(state(), config().config);
    expect(requests[1].steps.at(-1)).toMatchObject({ type: "function_result", result: "unknown tool: run_sql", is_error: true });
  });

  it("shows the refused change and why, to fix it", async () => {
    const { deps, requests } = fakeDeps({ author: [good()] });
    const draft = { change, explanation: "Counts." };
    await authorNode(deps)(state({ draft, refusal: "It was applied as cell c9 and ran with an error:\nno table" }), config().config);
    const first = (requests[0].steps[0] as Extract<Step, { type: "user_input" }>).content[0].text;
    expect(first).toContain(`Your previous change:\n${JSON.stringify(draft)}`);
    expect(first).toContain("It was refused: It was applied as cell c9 and ran with an error:\nno table\nFix it.");
    expect(requests[0].system).toContain("editing the cell it made");
  });

  it("gives up with the last problem after AUTHOR_STEPS calls without a valid change", async () => {
    const bad = () => calling(submit("s", { change: { action: "run_cell" }, explanation: "x" }));
    const { deps, requests } = fakeDeps({ author: Array.from({ length: AUTHOR_STEPS }, bad) });
    const out = await authorNode(deps)(state(), config().config);

    expect(requests).toHaveLength(AUTHOR_STEPS);
    expect(out.draft).toBeNull();
    expect(out.handoffResult).toMatch(/^The author could not write the change: .*cellId/s);
    expect(out).toMatchObject({ steps: 2 + AUTHOR_STEPS, usage: { input: 5 + 10 * AUTHOR_STEPS, output: 1 + 2 * AUTHOR_STEPS } });
  });

  it("says no change was submitted when it only talked", async () => {
    const { deps } = fakeDeps({ author: Array.from({ length: AUTHOR_STEPS }, () => answering("I think...")) });
    const out = await authorNode(deps)(state(), config().config);
    expect(out).toMatchObject({ draft: null, handoffResult: "The author could not write the change: no change submitted" });
  });

  it("stops at the turn's step limit", async () => {
    const { deps, requests } = fakeDeps({ author: [answering("hm"), answering("hm")] });
    const out = await authorNode(deps)(state({ steps: MAX_STEPS - 1 }), config().config);
    expect(requests).toHaveLength(1);
    expect(out).toMatchObject({ draft: null, steps: MAX_STEPS });
  });
});
