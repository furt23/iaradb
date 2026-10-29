import { describe, expect, it } from "vitest";

import { checkModel } from "./check";
import { factSql, keyName, planFacts } from "./facts";

const { model } = checkModel(
  [
    "relate(orders.customer_id, customers.id)",
    "relate(customers.city_id, cities.id)",
    "relate(goals.customer_id, customers.id)",
    "revenue = sum(orders.a)",
    "n = count_rows(orders)",
    "target = sum(goals.amount)",
    "ratio = revenue / target",
    "ticket = revenue / n",
  ].join("\n"),
  {
    orders: ["a", "customer_id"],
    customers: ["id", "region", "city_id"],
    cities: ["id", "state"],
    goals: ["amount", "customer_id"],
  },
);
const measures = (...names: string[]) => names.map((n) => model.measures.find((m) => m.name === n)!);
const key = (dataset: string, column: string) => ({ dataset, column });
const source = (d: string) => `SELECT * FROM ${d}`;

describe("planFacts", () => {
  it("makes a fact of each dataset the atoms read, in order of first use, and numbers the atoms across them", () => {
    const { facts } = planFacts(model.relationships, measures("target", "revenue", "n"), []);
    expect(facts.map((f) => f.dataset)).toEqual(["goals", "orders"]);
    expect(facts[0].atoms).toEqual([{ sql: 'SUM("amount")', alias: "__a0" }]);
    expect(facts[1].atoms).toEqual([
      { sql: 'SUM("a")', alias: "__a1" },
      { sql: "COUNT(*)", alias: "__a2" },
    ]);
  });

  it("gives the same atom of two measures one place", () => {
    const plan = planFacts(model.relationships, measures("revenue", "ticket", "ratio"), []);
    expect(plan.facts.flatMap((f) => f.atoms).map((a) => a.sql)).toEqual(['SUM("a")', "COUNT(*)", 'SUM("amount")']);
    const [revenue, ticket] = measures("revenue", "ticket");
    expect(plan.where(ticket.atoms[0])).toEqual(plan.where(revenue.atoms[0]));
    expect(plan.where(ticket.atoms[1])).toEqual({ fact: 0, alias: "__a1" });
  });

  it("finds what each fact reaches: the steps to the column's dataset, empty for its own, null for none", () => {
    const keys = [key("orders", "a"), key("cities", "state"), key("goals", "amount")];
    const { facts } = planFacts(model.relationships, measures("revenue"), keys);
    expect(facts[0].paths?.map((p) => p && p.map((r) => `${r.many.dataset}>${r.one.dataset}`))).toEqual([[], ["orders>customers", "customers>cities"], null]);
  });
});

describe("factSql", () => {
  const sqlOf = (names: string[], keys: { dataset: string; column: string }[], fact = 0) => {
    const { facts } = planFacts(model.relationships, measures(...names), keys);
    return factSql(facts[fact], keys, source);
  };

  it("names the columns __k<i> and the atoms __a<n>, so that they cannot meet a dataset's columns", () => {
    expect(keyName(3)).toBe('"__k3"');
    expect(sqlOf(["revenue"], [key("orders", "a")])).toBe(
      'SELECT "__k0", SUM("a") AS "__a0" FROM (SELECT _f.*, _f."a" AS "__k0" FROM (SELECT * FROM orders) AS _f) AS _m GROUP BY "__k0"',
    );
  });

  it("has no GROUP BY without columns, and keeps the fact's own rows", () => {
    expect(sqlOf(["revenue", "n"], [])).toBe('SELECT SUM("a") AS "__a0", COUNT(*) AS "__a1" FROM (SELECT _f.* FROM (SELECT * FROM orders) AS _f) AS _m');
  });

  it("joins each step once and leaves out the columns the fact does not reach, keeping their numbers", () => {
    const sql = sqlOf(["target"], [key("cities", "state"), key("orders", "a"), key("customers", "region")]);
    expect(sql).toBe(
      'SELECT "__k0", "__k2", SUM("amount") AS "__a0" FROM (SELECT _f.*, _j1."state" AS "__k0", _j0."region" AS "__k2" FROM (SELECT * FROM goals) AS _f ' +
        'LEFT JOIN (SELECT * FROM customers) AS _j0 ON _f."customer_id" = _j0."id" ' +
        'LEFT JOIN (SELECT * FROM cities) AS _j1 ON _j0."city_id" = _j1."id") AS _m GROUP BY "__k0", "__k2"',
    );
  });
});
