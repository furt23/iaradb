import { describe, expect, it, vi } from "vitest";

import type { Agent } from "@/lib/agents/types";

import { agentAllow, agentBrief } from "./brief";
import { recordingSend } from "./record";

const agent: Agent = {
  slug: "sales",
  config: {
    id: "abcd1234",
    title: "Sales",
    description: "Orders and customers",
    tables: [
      { name: "main.tpch.orders", included: true, note: "one row per order", columns: { o_totalprice: "the order's value", o_comment: " " } },
      { name: "main.tpch.customer", included: true, note: "", columns: {} },
      { name: "main.tpch.lineitem", included: false, note: "left out", columns: {} },
    ],
    glossary: [{ term: "receita", definition: "sum of o_totalprice" }],
    style: { language: "pt", length: "short", charts: "never", tone: "formal" },
  },
  instructions: "Revenue excludes canceled orders.",
  examples: [{ question: "Revenue by month?", sql: "SELECT 1" }, { question: "Top customers?", sql: "" }],
};

describe("agentAllow", () => {
  it("is the agent's tables when the user is unchecked", () => {
    expect(agentAllow(null, agent)).toEqual(["main.tpch.orders", "main.tpch.customer"]);
  });
  it("never widens the user's grants", () => {
    expect(agentAllow(["main.tpch.orders"], agent)).toEqual(["main.tpch.orders"]);
    expect(agentAllow(["main"], agent)).toEqual(["main.tpch.orders", "main.tpch.customer"]);
    expect(agentAllow([], agent)).toEqual([]);
  });
  it("never reads a table left out", () => {
    expect(agentAllow(null, agent)).not.toContain("main.tpch.lineitem");
  });
  it("reads nothing with no tables", () => {
    expect(agentAllow(null, { ...agent, config: { ...agent.config, tables: [] } })).toEqual([]);
  });
});

describe("agentBrief", () => {
  it("has the instructions, the glossary, the readable tables with notes and the examples", async () => {
    const text = await agentBrief(agent, ["main.tpch.orders"]);
    expect(text).toContain('Agent "Sales": Orders and customers');
    expect(text).toContain("Revenue excludes canceled orders.");
    expect(text).toContain("- receita: sum of o_totalprice");
    expect(text).toContain("Answer in Brazilian Portuguese. Length: short");
    expect(text).toContain("Tone: formal.");
    expect(text).not.toContain("show_chart");
    expect(text).toContain("- main.tpch.orders: one row per order\n  - o_totalprice: the order's value");
    expect(text).not.toContain("o_comment");
    expect(text).not.toContain("main.tpch.customer");
    expect(text).toContain("Question: Revenue by month?\nSQL:\nSELECT 1");
    expect(text).toContain("Question: Top customers?");
  });
  it("says when no table is readable", async () => {
    expect(await agentBrief(agent, [])).toContain("(none:");
  });
});

describe("recordingSend", () => {
  it("passes events on and records the reply and the SQL once done", () => {
    const sent: string[] = [];
    const done = vi.fn();
    let clock = 1000;
    const send = recordingSend((e) => sent.push(e), done, () => (clock += 500));
    send("thread", { id: "t1", title: "" });
    send("tool", { agent: "analyst", tool: "list_tables" });
    send("tool", { agent: "analyst", tool: "run_sql", sql: "SELECT 2" });
    send("text", { delta: "Hello " });
    send("text", { delta: "there" });
    expect(done).not.toHaveBeenCalled();
    send("done", { messageId: "m" });
    expect(done).toHaveBeenCalledWith({ messageId: "m", threadId: "t1", answer: "Hello there", queries: ["SELECT 2"], ms: 500, charts: [] });
    expect(sent).toEqual(["thread", "tool", "tool", "text", "text", "done"]);
  });
  it("records nothing for a failed turn", () => {
    const done = vi.fn();
    const send = recordingSend(() => {}, done);
    send("failed", { message: "x" });
    expect(done).not.toHaveBeenCalled();
  });
});
