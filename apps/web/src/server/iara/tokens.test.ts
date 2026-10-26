import { describe, expect, it } from "vitest";

import type { Step } from "./state";
import { countSteps, countTokens, cutToTokens } from "./tokens";

describe("countTokens", () => {
  it("counts with OpenAI's encoding, locally", async () => {
    expect(await countTokens("hello world")).toBe(2);
    expect(await countTokens("SELECT o_orderstatus, count(*) FROM main.main.orders GROUP BY 1")).toBeGreaterThan(10);
  });

  it("counts empty text as 0", async () => {
    expect(await countTokens("")).toBe(0);
  });
});

describe("countSteps", () => {
  it("sums text parts, calls with their arguments, results and thought signatures", async () => {
    const steps: Step[] = [
      { type: "user_input", content: [{ type: "text", text: "hello there" }] }, // 2
      { type: "model_output", content: [{ type: "text", text: "hi" }] }, // 1
      { type: "model_output" }, // 0
      { type: "function_call", id: "c1", name: "run_sql", arguments: { sql: "select 1" } }, // run_sql {"sql":"select 1"}: 3 words
      { type: "function_result", call_id: "c1", result: "a b c d" }, // 4
      { type: "thought", signature: "x".repeat(9) }, // ceil(9 / 4) = 3
      { type: "thought" }, // 0
    ];
    const parts = await Promise.all(["hello there", "hi", 'run_sql {"sql":"select 1"}', "a b c d"].map(countTokens));
    expect(await countSteps(steps)).toBe(parts.reduce((x, y) => x + y) + 3);
  });
});

describe("cutToTokens", () => {
  it("returns the text when it fits", async () => {
    expect(await cutToTokens("a b c", 3)).toBe("a b c");
  });

  it("cuts the head to about the budget and marks the cut", async () => {
    const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const cut = await cutToTokens(text, 50);
    const marker = "\n… (cut)";
    expect(cut.endsWith(marker)).toBe(true);
    expect(text.startsWith(cut.slice(0, -marker.length))).toBe(true);
    expect(await countTokens(cut)).toBeLessThanOrEqual(55);
  });
});
