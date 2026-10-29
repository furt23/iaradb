import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AskDecision, AskProposal } from "@/lib/dashboards/ask";
import type { Dashboard } from "@/lib/dashboards/types";

import { renderDashboard } from "../dashboards/run";
import { saveDataset, saveLayout, saveWidget } from "../dashboards/store";
import { freeName, resumeAsk, startAsk, threadSlug, type AskDeps } from "./askGraph";
import { CODE_MODEL, FAST_MODEL, type Llm } from "./models";
import { describeTable, explainSql, listTables, type ToolContext } from "./tools";

vi.mock("./tools", () => ({ listTables: vi.fn(), describeTable: vi.fn(), explainSql: vi.fn() }));
vi.mock("../dashboards/store", () => ({ saveDataset: vi.fn(), saveWidget: vi.fn(), saveLayout: vi.fn() }));
vi.mock("../dashboards/run", () => ({ renderDashboard: vi.fn() }));

const SQL = "SELECT region, sum(amount) AS total FROM main.public.sales GROUP BY region";
const ME = "ana@example.com";
const tools = { request: vi.fn(), allow: ["main"] } as unknown as ToolContext;

/** what the code model answers (the widget carries an id of its own, which the code must ignore) */
const draft = (over: Record<string, unknown> = {}) => ({
  dataset: { name: "sales_by_region", sql: SQL },
  widget: { kind: "chart", id: "zzzzzzzz", title: "Sales by region", spec: { kind: "bar", x: "region", y: ["total"], agg: "sum", group: null } },
  explanation: "Total sales per region.",
  ...over,
});

const dashboard = (over: Partial<Dashboard> = {}): Dashboard => ({
  slug: "sales",
  config: { id: "abcd1234", title: "Sales", refresh_minutes: 10 },
  datasets: [],
  widgets: [],
  model: "",
  layout: [],
  problems: [],
  ...over,
});

/** a model that answers the link step with `link`, then the drafts in order (the last again when they run out) */
function fakeLlm(link: unknown, ...drafts: unknown[]) {
  const calls: { model: string; prompt: string }[] = [];
  let n = 0;
  const llm: Llm = async (model, _system, prompt) => {
    calls.push({ model, prompt });
    return model === FAST_MODEL ? link : drafts[Math.min(n++, drafts.length - 1)];
  };
  return { llm, calls, synth: () => calls.filter((c) => c.model === CODE_MODEL) };
}

const deps = (llm: Llm, d: Dashboard = dashboard()): AskDeps => ({ llm, tools, dashboard: d });

/** an Ask that reached the review */
async function started(llm: Llm, d?: Dashboard, email = ME): Promise<{ thread: string; proposal: AskProposal }> {
  const reply = await startAsk(deps(llm, d), email, "sales by region");
  if (!("thread" in reply)) throw new Error(`no proposal: ${reply.message}`);
  return reply;
}

const answer = (llm: Llm, thread: string, decision: AskDecision, d?: Dashboard, email = ME) => resumeAsk(deps(llm, d), thread, email, decision);
const nothingSaved = () => {
  expect(saveDataset).not.toHaveBeenCalled();
  expect(saveWidget).not.toHaveBeenCalled();
  expect(saveLayout).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listTables).mockResolvedValue([
    { name: "sales", full: "main.public.sales", format: "delta" },
    { name: "customers", full: "main.public.customers", format: "delta" },
  ]);
  vi.mocked(describeTable).mockImplementation(async (_ctx, name) => ({
    name: name.split(".").pop()!,
    full: name,
    columns: [
      { name: "region", type: "string" },
      { name: "amount", type: "double" },
    ],
    num_rows: 10,
  }));
  vi.mocked(explainSql).mockResolvedValue({ text: "" });
  vi.mocked(renderDashboard).mockImplementation(async (input) => ({ widgets: { [input.widgets[0].id]: { kind: "table", columns: [], rows: [], total: 0 } }, at: 0 }));
});

describe("link", () => {
  it("drops the tables outside the grants and keeps the others once", async () => {
    const { llm, calls } = fakeLlm({ tables: ["main.private.secret", "main.public.sales", "sales", "CUSTOMERS", 7] }, draft());
    await started(llm);
    expect(describeTable).toHaveBeenCalledTimes(2);
    expect(vi.mocked(describeTable).mock.calls.map((c) => c[1])).toEqual(["main.public.sales", "main.public.customers"]);
    // the model only ever saw the granted tables
    expect(calls[0].prompt).toContain("main.public.sales");
    expect(calls[0].prompt).not.toContain("secret");
  });

  it("keeps at most 5 tables", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ name: `t${i}`, full: `main.public.t${i}`, format: "delta" }));
    vi.mocked(listTables).mockResolvedValue(many);
    const { llm } = fakeLlm({ tables: many.map((t) => t.full) }, draft());
    await started(llm);
    expect(describeTable).toHaveBeenCalledTimes(5);
  });

  it("ends with the answer when the question is not about the data", async () => {
    const { llm, synth } = fakeLlm({ answer: "I can only answer questions about your tables." });
    expect(await startAsk(deps(llm), ME, "what is the weather?")).toEqual({ message: "I can only answer questions about your tables." });
    expect(describeTable).not.toHaveBeenCalled();
    expect(synth()).toHaveLength(0);
  });

  it("ends when every table the model named is outside the grants", async () => {
    const { llm } = fakeLlm({ tables: ["main.private.secret"] });
    expect(await startAsk(deps(llm), ME, "secrets")).toEqual({ message: "no table you can read answers this question" });
  });

  it("asks no model when the user can read no table", async () => {
    vi.mocked(listTables).mockResolvedValue([]);
    const { llm, calls } = fakeLlm({ tables: [] });
    expect(await startAsk(deps(llm), ME, "anything")).toEqual({ message: "there are no tables you can read" });
    expect(calls).toHaveLength(0);
  });
});

describe("validate", () => {
  it("retries with the refusal in the prompt, then proposes", async () => {
    vi.mocked(explainSql).mockRejectedValueOnce(new Error("column amnt not found"));
    const { llm, synth } = fakeLlm({ tables: ["main.public.sales"] }, draft({ explanation: "first" }), draft({ explanation: "second" }));
    const { proposal } = await started(llm);
    expect(synth()).toHaveLength(2);
    expect(synth()[1].prompt).toContain("column amnt not found");
    expect(synth()[1].prompt).toContain('"explanation":"first"');
    expect(proposal.explanation).toBe("second");
    expect(proposal.steps.filter((s) => s.step === "validate")).toEqual([{ step: "validate", note: "column amnt not found" }]);
  });

  it("gives up after 3 attempts with the last error", async () => {
    vi.mocked(explainSql).mockRejectedValue(new Error("boom"));
    const { llm, synth } = fakeLlm({ tables: ["main.public.sales"] }, draft());
    const reply = await startAsk(deps(llm), ME, "sales by region");
    expect(reply).toEqual({ message: "could not write a valid query: boom" });
    expect(synth()).toHaveLength(3);
    nothingSaved();
  });

  it("refuses what the repo's validators refuse, and says why", async () => {
    const bad = [
      draft({ dataset: { name: "Sales By Region", sql: SQL } }),
      draft({ dataset: { name: "sales_by_region", sql: `${SQL}; SELECT 2` } }),
      draft({ widget: { kind: "text", markdown: "hi" } }),
    ];
    const { llm, synth } = fakeLlm({ tables: ["main.public.sales"] }, ...bad);
    expect(await startAsk(deps(llm), ME, "q")).toEqual({ message: "could not write a valid query: widget kind is chart or table" });
    expect(synth()[1].prompt).toContain("dataset name is 1 to 64 characters");
    expect(synth()[2].prompt).toContain("a dataset holds one query");
    // refused before the engine is asked
    expect(explainSql).not.toHaveBeenCalled();
  });

  it("renames a dataset that clashes and forces the widget onto it, with an id of its own", async () => {
    const taken = dashboard({
      datasets: [
        { name: "sales_by_region", sql: "SELECT 1", params: {} },
        { name: "sales_by_region_2", sql: "SELECT 1", params: {} },
      ],
      widgets: [{ id: "aaaaaaaa", kind: "text", markdown: "x" }],
    });
    const { llm } = fakeLlm({ tables: ["main.public.sales"] }, draft({ widget: { ...draft().widget, dataset: "other" } }));
    const { proposal } = await started(llm, taken);
    expect(proposal.dataset.name).toBe("sales_by_region_3");
    expect(proposal.widget).toMatchObject({ kind: "chart", dataset: "sales_by_region_3" });
    expect(proposal.widget.id).toMatch(/^[a-z0-9]{8}$/);
    expect(proposal.widget.id).not.toBe("zzzzzzzz");
    expect(explainSql).toHaveBeenCalledWith(tools, SQL);
  });
});

describe("review", () => {
  it("previews the widget with the user's grants; a failed preview is data, not a failure", async () => {
    vi.mocked(renderDashboard).mockRejectedValue(new Error("no read grant on table main.public.sales"));
    const { llm } = fakeLlm({ tables: ["main.public.sales"] }, draft());
    const { proposal } = await started(llm);
    expect(proposal.preview).toEqual({ kind: "error", message: "no read grant on table main.public.sales" });
    expect(renderDashboard).toHaveBeenCalledWith(
      { datasets: [{ name: "sales_by_region", sql: SQL, params: {} }], widgets: [proposal.widget] },
      {},
      expect.objectContaining({ request: tools.request, allow: ["main"], redact: false, source: "ask" }),
    );
  });

  it("saves nothing before the user approves", async () => {
    const { llm } = fakeLlm({ tables: ["main.public.sales"] }, draft());
    const { proposal } = await started(llm);
    expect(proposal.tables).toEqual(["main.public.sales"]);
    expect(proposal.steps.map((s) => s.step)).toEqual(["link", "describe", "synthesize"]);
    nothingSaved();
  });

  it("approve saves the dataset, the widget and the layout (at the bottom)", async () => {
    const d = dashboard({ layout: [{ widget: "aaaaaaaa", x: 0, y: 2, w: 6, h: 8 }] });
    const { llm } = fakeLlm({ tables: ["main.public.sales"] }, draft());
    const { thread, proposal } = await started(llm, d);

    const done = await answer(llm, thread, { kind: "approve" }, d);

    expect(done).toEqual({ saved: { dataset: "sales_by_region", widget: proposal.widget.id } });
    expect(saveDataset).toHaveBeenCalledWith("sales", "sales_by_region", `${SQL}\n`);
    expect(saveWidget).toHaveBeenCalledWith("sales", { ...proposal.widget, dataset: "sales_by_region" });
    expect(saveLayout).toHaveBeenCalledWith("sales", [
      { widget: "aaaaaaaa", x: 0, y: 2, w: 6, h: 8 },
      { widget: proposal.widget.id, x: 0, y: 10, w: 6, h: 8 },
    ]);
    // finished: the thread is gone
    await expect(answer(llm, thread, { kind: "approve" }, d)).rejects.toThrow("there is no such question");
  });

  it("approve never writes over a dataset that appeared while the user was looking", async () => {
    const { llm } = fakeLlm({ tables: ["main.public.sales"] }, draft());
    const { thread } = await started(llm);
    const now = dashboard({ datasets: [{ name: "sales_by_region", sql: "SELECT 1", params: {} }] });

    const done = await answer(llm, thread, { kind: "approve" }, now);

    expect(done).toMatchObject({ saved: { dataset: "sales_by_region_2" } });
    expect(saveDataset).toHaveBeenCalledWith("sales", "sales_by_region_2", `${SQL}\n`);
    expect(saveWidget).toHaveBeenCalledWith("sales", expect.objectContaining({ dataset: "sales_by_region_2" }));
  });

  it("cancel saves nothing and ends the thread", async () => {
    const { llm } = fakeLlm({ tables: ["main.public.sales"] }, draft());
    const { thread } = await started(llm);
    expect(await answer(llm, thread, { kind: "cancel" })).toEqual({ message: "cancelled" });
    nothingSaved();
    await expect(answer(llm, thread, { kind: "approve" })).rejects.toThrow("there is no such question");
  });

  it("change runs the code model again with the feedback and the previous answer", async () => {
    const { llm, synth } = fakeLlm({ tables: ["main.public.sales"] }, draft({ explanation: "first" }), draft({ explanation: "second" }));
    const { thread } = await started(llm);

    const next = await answer(llm, thread, { kind: "change", feedback: "make it a line chart" });

    expect(synth()).toHaveLength(2);
    expect(synth()[1].prompt).toContain("make it a line chart");
    expect(synth()[1].prompt).toContain('"explanation":"first"');
    expect(next).toMatchObject({ thread, proposal: { explanation: "second" } });
    nothingSaved();
    // the same thread can still be approved
    expect(await answer(llm, thread, { kind: "approve" })).toMatchObject({ saved: { dataset: "sales_by_region" } });
  });

  it("change gets 3 attempts of its own", async () => {
    const { llm, synth } = fakeLlm({ tables: ["main.public.sales"] }, draft());
    const { thread } = await started(llm);
    vi.mocked(explainSql).mockRejectedValueOnce(new Error("one")).mockRejectedValueOnce(new Error("two"));

    const next = await answer(llm, thread, { kind: "change", feedback: "again" });

    expect(next).toHaveProperty("proposal");
    expect(synth()).toHaveLength(4);
  });

  it("refuses an answer that is not a decision and keeps the thread", async () => {
    const { llm } = fakeLlm({ tables: ["main.public.sales"] }, draft());
    const { thread } = await started(llm);
    await expect(answer(llm, thread, { kind: "change", feedback: "  " })).rejects.toThrow("the change is 1 to 2000 characters");
    await expect(answer(llm, thread, { kind: "delete" } as unknown as AskDecision)).rejects.toThrow("approve, change or cancel");
    expect(await answer(llm, thread, { kind: "approve" })).toHaveProperty("saved");
  });
});

describe("threads", () => {
  it("another user cannot resume a thread, and nothing is saved", async () => {
    const { llm } = fakeLlm({ tables: ["main.public.sales"] }, draft());
    const { thread } = await started(llm);

    await expect(answer(llm, thread, { kind: "approve" }, undefined, "eve@example.com")).rejects.toThrow("there is no such question");
    expect(() => threadSlug(thread, "eve@example.com")).toThrow("there is no such question");
    nothingSaved();

    // the owner still can; the slug it was started on is known
    expect(threadSlug(thread, ME.toUpperCase())).toBe("sales");
    expect(await answer(llm, thread, { kind: "approve" })).toHaveProperty("saved");
  });

  it("a thread cannot be resumed on another dashboard", async () => {
    const { llm } = fakeLlm({ tables: ["main.public.sales"] }, draft());
    const { thread } = await started(llm);
    await expect(answer(llm, thread, { kind: "approve" }, dashboard({ slug: "other" }))).rejects.toThrow("there is no such question");
    nothingSaved();
  });

  it("an unknown thread is not found", async () => {
    const { llm } = fakeLlm({});
    await expect(answer(llm, "nope", { kind: "approve" })).rejects.toThrow("there is no such question");
  });

  it("a thread nobody answered for 30 minutes is dropped", async () => {
    const { llm } = fakeLlm({ tables: ["main.public.sales"] }, draft());
    const { thread } = await started(llm);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 31 * 60_000 });
    try {
      await expect(answer(llm, thread, { kind: "approve" })).rejects.toThrow("there is no such question");
    } finally {
      vi.useRealTimers();
    }
    nothingSaved();
  });

  it("refuses a question that is empty or too long", async () => {
    const { llm, calls } = fakeLlm({});
    await expect(startAsk(deps(llm), ME, "   ")).rejects.toThrow("the question is 1 to 2000 characters");
    await expect(startAsk(deps(llm), ME, "x".repeat(2001))).rejects.toThrow("the question is 1 to 2000 characters");
    expect(calls).toHaveLength(0);
  });
});

describe("freeName", () => {
  it("numbers a taken name from 2 and stays within 64 characters", () => {
    expect(freeName("a", [])).toBe("a");
    expect(freeName("a", ["a"])).toBe("a_2");
    expect(freeName("a", ["a", "a_2"])).toBe("a_3");
    const long = "x".repeat(64);
    expect(freeName(long, [long])).toBe(`${"x".repeat(62)}_2`);
  });
});
