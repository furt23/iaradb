import { describe, expect, it } from "vitest";

import { parseOntology } from "./ontology";
import { checkLesson, mergeLesson, type Lesson } from "./ontologyLearn";

const TABLES = [
  { full: "main.sales.orders", columns: ["id", "customer_id", "Amount", "discount"] },
  { full: "main.sales.customers", columns: ["id", "name"] },
];

const term = (over: Record<string, unknown>) => ({ name: "Net revenue", description: "Revenue after discounts.", synonyms: [], columns: ["main.sales.orders.amount"], sql: "", ...over });

describe("checkLesson", () => {
  it("keeps what the tables support, with columns as the tables write them", () => {
    const out = checkLesson(
      {
        terms: [term({ synonyms: ["receita líquida", " ", "Net Revenue"], columns: ["MAIN.SALES.ORDERS.AMOUNT", "main.sales.orders.amount", "main.sales.orders.tax"], sql: " sum(amount)\n  - sum(discount) " })],
        joins: [{ left: "main.sales.orders.customer_id", right: "main.sales.customers.id", description: "" }],
      },
      TABLES,
    );
    expect(out).toEqual({
      terms: [{ name: "Net revenue", description: "Revenue after discounts.", synonyms: ["receita líquida"], columns: ["main.sales.orders.Amount"], sql: "sum(amount)\n  - sum(discount)" }],
      joins: [{ left: "main.sales.orders.customer_id", right: "main.sales.customers.id", description: null }],
      dropped: 0,
    });
  });

  it("drops a term whose columns do not exist, one without a name or description, and one named twice", () => {
    const out = checkLesson(
      {
        terms: [
          term({ name: "Ghost", columns: ["main.sales.orders.nope", "main.hr.salaries.amount"] }),
          term({ name: "", columns: [] }),
          term({ name: "No words", description: "  " }),
          term({ name: "Fiscal year", description: "Starts in April.", columns: [] }),
          term({}),
          term({ name: "NET  REVENUE" }),
        ],
        joins: [],
      },
      TABLES,
    );
    expect(out.terms.map((t) => t.name)).toEqual(["Fiscal year", "Net revenue"]);
    expect(out.terms[0]).toMatchObject({ columns: [], sql: null });
    expect(out.dropped).toBe(4);
  });

  it("drops a join with a column that does not exist, with itself, or already given the other way round", () => {
    const j = { left: "main.sales.orders.customer_id", right: "main.sales.customers.id", description: "each order has one customer" };
    const out = checkLesson({ terms: [], joins: [j, { ...j, left: j.right, right: j.left }, { ...j, right: "main.sales.customers.uuid" }, { ...j, right: j.left }] }, TABLES);
    expect(out.joins).toEqual([j]);
    expect(out.dropped).toBe(3);
  });

  it("takes anything that is not a lesson as an empty one", () => {
    for (const raw of [null, "text", { terms: "many", joins: 3 }, { terms: [null, 1, "x"] }]) expect(checkLesson(raw, TABLES).terms).toEqual([]);
    expect(checkLesson({ terms: [null] }, TABLES).dropped).toBe(1);
  });
});

const LESSON: Lesson = {
  terms: [
    { name: "Net revenue", description: 'Revenue after "discounts".', synonyms: ["receita líquida"], columns: ["main.sales.orders.Amount"], sql: "sum(amount)\n  - sum(discount)" },
    { name: "Fiscal year", description: "Starts in April.", synonyms: [], columns: [], sql: null },
  ],
  joins: [{ left: "main.sales.orders.customer_id", right: "main.sales.customers.id", description: "each order has one customer" }],
};

describe("mergeLesson", () => {
  it("starts a team's file with its name, for editors, and writes everything as certified", () => {
    const out = mergeLesson("finance", null, LESSON, { name: " Finance ", by: "ana@example.com", date: "2026-11-12" });
    expect(out).toMatchObject({ terms: 2, joins: 1, known: 0 });
    expect(out.text.startsWith('[ontology]\nname = "Finance"\nreaders = ["editors"]\n')).toBe(true);
    expect(out.text).toContain("# Taught to Iara by ana@example.com on 2026-11-12.");
    const o = parseOntology("finance", out.text);
    expect(o.terms).toEqual([
      { name: "Net revenue", description: 'Revenue after "discounts".', synonyms: ["receita líquida"], certified: true, columns: ["main.sales.orders.Amount"], tables: [], sql: "sum(amount)\n  - sum(discount)" },
      { name: "Fiscal year", description: "Starts in April.", synonyms: [], certified: true, columns: [], tables: [], sql: null },
    ]);
    expect(o.joins).toEqual([{ ...LESSON.joins[0], certified: true }]);
    expect(mergeLesson("ops", null, LESSON, { by: "ana@example.com", date: "2026-11-12" }).text.startsWith('[ontology]\nname = "ops"\n')).toBe(true);
  });

  it("writes at the end of a file and leaves every line that was there as it was", () => {
    const existing = [
      "# Finance, kept by Ana",
      "[ontology]",
      'name = "Finance"',
      'owners = ["ana@example.com"]',
      "",
      "[[term]]",
      'name = "NET REVENUE"   # reviewed in October',
      'description = "The certified one."',
      "certified = true",
      "",
      "[[join]]",
      'left = "main.sales.customers.id"',
      'right = "main.sales.orders.customer_id"',
      "certified = true",
    ].join("\n");
    const out = mergeLesson("finance", existing, LESSON, { by: "ana@example.com", date: "2026-11-12" });
    // net revenue and the join (the other way round) are already there
    expect(out).toMatchObject({ terms: 1, joins: 0, known: 2 });
    expect(out.text.startsWith(`${existing}\n\n# Taught to Iara`)).toBe(true);
    const o = parseOntology("finance", out.text);
    expect(o.terms.map((t) => [t.name, t.certified])).toEqual([
      ["NET REVENUE", true],
      ["Fiscal year", true],
    ]);
    expect(o.owners).toEqual(["ana@example.com"]);
    expect(o.joins).toHaveLength(1);
  });

  it("changes nothing when the file already has everything", () => {
    const first = mergeLesson("finance", null, LESSON, { by: "ana@example.com", date: "2026-11-12" }).text;
    expect(mergeLesson("finance", first, LESSON, { by: "ana@example.com", date: "2026-11-13" })).toEqual({ text: first, terms: 0, joins: 0, known: 3 });
  });

  it("keeps SQL that a literal block cannot hold", () => {
    const sql = "select '''x'''\nfrom t where a = 'b'";
    const out = mergeLesson("finance", null, { terms: [{ ...LESSON.terms[0], sql }, { ...LESSON.terms[1], sql: "x = 'a\nb'" }], joins: [] }, { by: "ana@example.com", date: "2026-11-12" });
    expect(parseOntology("finance", out.text).terms.map((t) => t.sql)).toEqual([sql, "x = 'a\nb'"]);
  });

  it("refuses to write into a file that cannot be read", () => {
    expect(() => mergeLesson("finance", "[[term]]\nname = 1", LESSON, { by: "ana@example.com", date: "2026-11-12" })).toThrow();
  });
});
