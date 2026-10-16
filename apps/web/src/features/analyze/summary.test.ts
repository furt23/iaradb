import type { QueryAnalysis } from "@iara/protocol";
import { describe, expect, it } from "vitest";

import { summaryFacts } from "./summary";

const base: Pick<QueryAnalysis, "rows" | "profile"> = {
  rows: 1234,
  profile: { id: 1, elapsed_ms: 2000, cancelled: false, pipelines: [] },
};

describe("summaryFacts", () => {
  it("summarizes the run", () => {
    const facts = summaryFacts(base);
    expect(facts.map((f) => f.label)).toEqual(["Total time", "Rows", "Peak memory", "Spilled", "Pipelines"]);
    expect(facts.map((f) => f.value)).toEqual(["2.00 s", "1,234", "—", "0 B", "0"]);
  });

  it("shows memory and spill when the run reports them", () => {
    const facts = summaryFacts({ ...base, profile: { ...base.profile, memory_peak: 4096, spilled_bytes: 3 * 1024 * 1024 } });
    expect(facts.find((f) => f.label === "Peak memory")?.value).toBe("4.0 KB");
    expect(facts.find((f) => f.label === "Spilled")?.value).toBe("3.0 MB");
  });

  it("adds the storage requests when the engine reports them", () => {
    const facts = summaryFacts({ ...base, requests: { list: 3, head: 1, get: 12, bytes: 4096 } });
    expect(facts[facts.length - 1]).toEqual({ label: "Storage requests", value: "12 GET · 3 LIST · 1 HEAD", hint: "4.0 KB read" });
    expect(summaryFacts(base)).toHaveLength(5);
  });
});
