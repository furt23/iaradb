import { describe, expect, it } from "vitest";

import { formatSql } from "./sqlFormat";

describe("formatSql", () => {
  it("puts each clause on its own line, keywords upper case", () => {
    expect(formatSql("select year(o_orderdate) as ano, sum(o_totalprice) as receita from main.tpch.orders group by 1 order by 1")).toBe(
      ["SELECT", "  year(o_orderdate) AS ano,", "  sum(o_totalprice) AS receita", "FROM", "  main.tpch.orders", "GROUP BY", "  1", "ORDER BY", "  1"].join("\n"),
    );
  });

  it("gives back what it cannot parse", () => {
    expect(formatSql("select 'unclosed")).toBe("select 'unclosed");
  });
});
