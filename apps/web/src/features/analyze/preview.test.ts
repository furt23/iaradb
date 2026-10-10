import { describe, expect, it } from "vitest";

import { preview } from "./preview";

describe("preview", () => {
  it("collapses whitespace onto one line", () => {
    expect(preview("  select\n\tx  from t ")).toBe("select x from t");
  });

  it("cuts long queries, ending with an ellipsis", () => {
    const cut = preview("x".repeat(300), 20);
    expect(cut).toHaveLength(20);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("keeps short queries whole", () => {
    expect(preview("select 1", 20)).toBe("select 1");
  });
});
