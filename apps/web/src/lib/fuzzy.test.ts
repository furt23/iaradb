import { describe, expect, it } from "vitest";

import { fuzzyFilter, fuzzyScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("matches characters in order, case-insensitively", () => {
    expect(fuzzyScore("tour", "notebooks/tpch_tour.py")).not.toBeNull();
    expect(fuzzyScore("TT", "notebooks/tpch_tour.py")).not.toBeNull();
    expect(fuzzyScore("ruot", "notebooks/tpch_tour.py")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("prefers word starts, runs and the file name", () => {
    const a = fuzzyScore("li", "lineitem")!;
    const b = fuzzyScore("li", "supplier_list")!;
    expect(a).toBeGreaterThan(b);
    // "rev" is the name of one, the folder of the other
    expect(fuzzyScore("rev", "queries/revenue.sql")!).toBeGreaterThan(fuzzyScore("rev", "reviews/q.sql")!);
  });
});

describe("fuzzyFilter", () => {
  const items = ["notebooks/tpch_tour.py", "notebooks/tpch_heavy.py", "lineitem", "lineitem_sf10", "queries/line_counts.sql"];

  it("ranks exact names first", () => {
    expect(fuzzyFilter(items, "lineitem", (s) => s)[0]).toBe("lineitem");
  });

  it("keeps the given order for an empty query, up to a limit", () => {
    expect(fuzzyFilter(items, "", (s) => s, 2)).toEqual(items.slice(0, 2));
  });

  it("drops what does not match", () => {
    expect(fuzzyFilter(items, "heavy", (s) => s)).toEqual(["notebooks/tpch_heavy.py"]);
  });
});
