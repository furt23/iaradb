import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";

import type { IaraDecision, IaraOutcome } from "@/lib/iara/protocol";

import { MAX_FIXES, type IaraGraphState } from "../state";
import { observerNode } from "./observer";

vi.mock("../tokens", () => ({
  countTokens: async (text: string) => Math.ceil(text.length / 4),
  countSteps: async () => 0,
  cutToTokens: async (text: string, max: number) => (text.length / 4 > max ? `${text.slice(0, max * 4)}\n… (cut)` : text),
}));

const approve = (outcome: Partial<IaraOutcome>, run = true): IaraDecision => ({ kind: "approve", run, outcome: { applied: true, ran: false, ...outcome } });
const state = (decision: IaraDecision, over: Partial<IaraGraphState> = {}): IaraGraphState => ({ decision, fixes: 0, reviews: 1, reviewNotes: null, ...over }) as IaraGraphState;

const run = async (s: IaraGraphState) => {
  const writer = vi.fn();
  const out = await observerNode()(s, { writer } as unknown as LangGraphRunnableConfig);
  return { out, writer };
};

describe("observerNode", () => {
  it("reports a rejection, with what the user said", async () => {
    const { out, writer } = await run(state({ kind: "reject", feedback: "use the 2024 table" }));
    expect(writer).toHaveBeenCalledWith({ type: "agent", agent: "observer" });
    expect(out).toEqual({ handoffResult: "The user rejected the change. They said: use the 2024 table" });
    expect((await run(state({ kind: "reject" }))).out).toEqual({ handoffResult: "The user rejected the change." });
  });

  it("sends a failed run back to the author while fixes are left", async () => {
    const decision = approve({ cellId: "c9", ran: true, status: "error", error: "NameError: x", output: "Traceback..." });
    const { out } = await run(state(decision, { fixes: MAX_FIXES - 1 }));
    expect(out).toEqual({ refusal: "It was applied as cell c9 and ran with an error:\nNameError: x\nTraceback...", fixes: MAX_FIXES, reviews: 0 });
    expect(out).not.toHaveProperty("handoffResult");
  });

  it("words the refusal without a cell or a message", async () => {
    const { out } = await run(state(approve({ ran: true, status: "error" })));
    expect(out.refusal).toBe("It was applied and ran with an error:\n");
  });

  it("reports a failed run to iara once the fixes are used", async () => {
    const decision = approve({ cellId: "c9", ran: true, status: "error", error: "NameError: x" });
    const { out } = await run(state(decision, { fixes: MAX_FIXES, reviewNotes: "Reads a big table." }));
    expect(out).toEqual({ handoffResult: "The change was applied as cell c9.\nIt ran with status error.\nError: NameError: x\nThe reviewer noted: Reads a big table." });
  });

  it("reports a run that went well, with its output", async () => {
    const { out } = await run(state(approve({ cellId: "c2", ran: true, status: "ok", output: "count\n7" })));
    expect(out).toEqual({ handoffResult: "The change was applied as cell c2.\nIt ran with status ok.\nOutput:\ncount\n7" });
  });

  it("reports a change that was applied only", async () => {
    const { out } = await run(state(approve({ cellId: "c2" }, false)));
    expect(out).toEqual({ handoffResult: "The change was applied as cell c2.\nIt was not run." });
  });

  it("reports a change the browser could not apply, and why", async () => {
    const { out } = await run(state(approve({ applied: false, error: "the cell was deleted" })));
    expect(out).toEqual({ handoffResult: "The change was not applied: the cell was deleted\nIt was not run." });
  });

  it("cuts a long output to 4000 tokens", async () => {
    const { out } = await run(state(approve({ ran: true, status: "ok", output: "x".repeat(40_000) })));
    expect((out.handoffResult as string).length).toBeLessThan(4000 * 4 + 200);
    expect(out.handoffResult).toMatch(/… \(cut\)$/);
  });
});
