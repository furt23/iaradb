import { describe, expect, it } from "vitest";

import { mayTeachOntology, mayReadOntology, parseOntology, readableOntology, sameJoin, searchOntologies, termTables } from "./ontology";

const FINANCE = `
[ontology]
name = "Finance"
description = "Revenue and billing."
readers = ["editors", "Ana@Example.com"]
owners = ["Bia@Example.com"]

[[term]]
name = "Net revenue"
description = "Revenue after discounts, before tax."
synonyms = ["receita líquida", "net sales"]
certified = true
columns = ["Main.Sales.Orders.amount", "main.sales.orders.Discount"]
sql = "sum(amount * (1 - discount))"

[[term]]
name = "Churned customer"
description = "A customer with no order in the last 90 days."
columns = ["main.sales.customers.id"]
tables = ["main.sales.orders"]

[[term]]
name = "Fiscal year"
description = "Starts on April 1st."
certified = true

[[join]]
left = "main.sales.orders.customer_id"
right = "main.sales.customers.id"
description = "each order has one customer"
certified = true
`;

const everything = () => true;

describe("parseOntology", () => {
  it("reads a team's terms and joins, with tables in lowercase and columns as written", () => {
    const o = parseOntology("finance", FINANCE);
    expect(o).toMatchObject({ team: "finance", name: "Finance", description: "Revenue and billing.", readers: ["editors", "ana@example.com"], owners: ["bia@example.com"] });
    expect(o.terms[0]).toEqual({
      name: "Net revenue",
      description: "Revenue after discounts, before tax.",
      synonyms: ["receita líquida", "net sales"],
      certified: true,
      columns: ["main.sales.orders.amount", "main.sales.orders.Discount"],
      tables: [],
      sql: "sum(amount * (1 - discount))",
    });
    expect(o.terms[1]).toMatchObject({ certified: false, sql: null, synonyms: [] });
    expect(o.joins).toEqual([{ left: "main.sales.orders.customer_id", right: "main.sales.customers.id", description: "each order has one customer", certified: true }]);
  });

  it("names an empty file after its team, for editors", () => {
    expect(parseOntology("ops", "")).toEqual({ team: "ops", name: "ops", description: null, readers: ["editors"], owners: [], terms: [], joins: [] });
    expect(parseOntology("ops", '[ontology]\nname = "Ops"')).toMatchObject({ name: "Ops", readers: ["editors"], owners: [] });
  });

  it("refuses what it does not understand, so a typo never hides a definition", () => {
    expect(() => parseOntology("finance", '[[term]]\nname = "A"\ndescription = "b"\ncertfied = true')).toThrow(/certfied/);
    expect(() => parseOntology("finance", '[[term]]\nname = "A"\ndescription = "b"\ncolumns = ["orders.amount"]')).toThrow(/catalog\.schema\.table\.column/);
    expect(() => parseOntology("finance", '[[term]]\nname = "A"\ndescription = "b"\ntables = ["sales.orders"]')).toThrow(/catalog\.schema\.table/);
    expect(() => parseOntology("finance", '[ontology]\nreaders = ["viewers"]')).toThrow(/email or editors/);
    expect(() => parseOntology("finance", '[ontology]\nowners = ["editors"]')).toThrow(/owner is an email/);
    expect(() => parseOntology("finance", '[[term]]\nname = "Receita"\ndescription = "a"\n[[term]]\nname = "receita"\ndescription = "b"')).toThrow(/defined twice/);
    expect(() => parseOntology("finance", "[[term")).toThrow(/not valid TOML/);
    expect(() => parseOntology("../x", "")).toThrow(/not a team id/);
  });
});

describe("mayReadOntology", () => {
  const admin = { email: "boss@example.com", admin: true };
  const editor = { email: "Bia@example.com", admin: false };
  const viewer = { email: "bia@example.com", admin: false, viewer: true };

  it("lets admins read every ontology, and the others those that name them or editors", () => {
    expect(mayReadOntology(admin, { readers: [] })).toBe(true);
    expect(mayReadOntology(editor, { readers: ["editors"] })).toBe(true);
    expect(mayReadOntology(editor, { readers: ["bia@example.com"] })).toBe(true);
    expect(mayReadOntology(editor, { readers: ["ana@example.com"] })).toBe(false);
    expect(mayReadOntology(editor, { readers: [] })).toBe(false);
  });

  it("never lets a viewer read one, nor a user without an email be named", () => {
    expect(mayReadOntology(viewer, { readers: ["editors", "bia@example.com"] })).toBe(false);
    expect(mayReadOntology({ email: "", admin: false }, { readers: [""] })).toBe(false);
  });
});

describe("mayTeachOntology", () => {
  it("lets admins teach any team, a new one included, and owners for theirs", () => {
    expect(mayTeachOntology({ email: "boss@example.com", admin: true }, null)).toBe(true);
    expect(mayTeachOntology({ email: "Bia@example.com", admin: false }, { owners: ["bia@example.com"] })).toBe(true);
    expect(mayTeachOntology({ email: "ana@example.com", admin: false }, { owners: ["bia@example.com"] })).toBe(false);
    expect(mayTeachOntology({ email: "bia@example.com", admin: false }, null)).toBe(false);
    expect(mayTeachOntology({ email: "bia@example.com", admin: false, viewer: true }, { owners: ["bia@example.com"] })).toBe(false);
    expect(mayTeachOntology({ email: "", admin: false }, { owners: [] })).toBe(false);
  });
});

describe("readableOntology", () => {
  it("leaves out the terms and joins over a table that may not be read", () => {
    const o = readableOntology(parseOntology("finance", FINANCE), (t) => t === "main.sales.orders");
    expect(o.terms.map((t) => t.name)).toEqual(["Net revenue", "Fiscal year"]);
    expect(o.joins).toEqual([]);
    expect(o.name).toBe("Finance");
  });
});

describe("sameJoin", () => {
  it("is the same pair of columns in either direction", () => {
    const j = { left: "a.b.c.x", right: "a.b.d.y" };
    expect(sameJoin(j, { left: "a.b.d.y", right: "A.B.C.X" })).toBe(true);
    expect(sameJoin(j, { left: "a.b.c.x", right: "a.b.d.z" })).toBe(false);
  });
});

describe("searchOntologies", () => {
  const finance = parseOntology("finance", FINANCE);
  const names = (query: string, canRead: (t: string) => boolean = everything) => searchOntologies([finance], query, canRead).terms.map((t) => t.name);

  it("finds a term by its name, a synonym without accents, a column or its description", () => {
    expect(names("net revenue by month")).toEqual(["Net revenue"]);
    expect(names("qual a RECEITA LIQUIDA?")).toEqual(["Net revenue"]);
    expect(names("discount")).toEqual(["Net revenue"]);
    expect(names("customers that churned")).toEqual(["Churned customer"]);
    expect(names("when does the fiscal year start")).toEqual(["Fiscal year"]);
  });

  it("finds nothing for words that name no term", () => {
    expect(searchOntologies([finance], "what is the weather", everything)).toEqual({ terms: [], joins: [], more: 0 });
  });

  it("lists every term for an empty query, the certified ones first", () => {
    expect(names("")).toEqual(["Fiscal year", "Net revenue", "Churned customer"]);
  });

  it("gives the team's name and leaves the tables of the SQL out", () => {
    const [term] = searchOntologies([finance], "churned", everything).terms;
    expect(term).toEqual({ team: "Finance", name: "Churned customer", description: "A customer with no order in the last 90 days.", synonyms: [], certified: false, columns: ["main.sales.customers.id"], sql: null });
  });

  it("leaves out a term over a table that may not be read, as if it did not exist", () => {
    const onlyOrders = (t: string) => t === "main.sales.orders";
    expect(names("", onlyOrders)).toEqual(["Fiscal year", "Net revenue"]);
    // churned customer reads customers through its columns and orders through its SQL
    expect(names("churned", (t) => t === "main.sales.customers")).toEqual([]);
    expect(searchOntologies([finance], "churned", onlyOrders).more).toBe(0);
  });

  it("gives the joins between the tables of the terms found, when both sides may be read", () => {
    expect(searchOntologies([finance], "net revenue", everything).joins).toEqual([{ team: "Finance", ...finance.joins[0] }]);
    expect(searchOntologies([finance], "net revenue", (t) => t === "main.sales.orders").joins).toEqual([]);
    expect(searchOntologies([finance], "fiscal year", everything).joins).toEqual([]);
    // a join is also found by the tables it names
    expect(searchOntologies([finance], "how do orders join", everything).joins).toHaveLength(1);
  });

  it("puts the best match first, certified before drafts, and counts what did not fit", () => {
    const many = parseOntology(
      "ops",
      ["Revenue draft", "Revenue", "Revenue target"].map((n, i) => `[[term]]\nname = "${n}"\ndescription = "x"\ncertified = ${i === 1}\n`).join("\n"),
    );
    const found = searchOntologies([many], "revenue", everything, 2);
    expect(found.terms.map((t) => t.name)).toEqual(["Revenue", "Revenue draft"]);
    expect(found.more).toBe(1);
  });
});

describe("termTables", () => {
  it("is every table a term names, once", () => {
    expect(termTables({ columns: ["a.b.c.x", "a.b.c.y", "a.b.d.z"], tables: ["a.b.c", "a.b.e"] })).toEqual(["a.b.c", "a.b.d", "a.b.e"]);
  });
});
