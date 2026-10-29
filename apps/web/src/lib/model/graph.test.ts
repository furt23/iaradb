import { describe, expect, it } from "vitest";

import { conflict, outgoing, pathToOne, reachable, visited } from "./graph";
import type { Relationship } from "./types";

const span = { from: 0, to: 0, line: 1, col: 1 };
/** `rel("orders.customer_id", "customers.id")` */
const rel = (many: string, one: string): Relationship => {
  const [md, mc] = many.split(".");
  const [od, oc] = one.split(".");
  return { many: { dataset: md, column: mc }, one: { dataset: od, column: oc }, span };
};

const orders = rel("orders.customer_id", "customers.id");
const customers = rel("customers.region_id", "regions.id");
const items = rel("items.order_id", "orders.id");
const goals = rel("goals.region_id", "regions.id");
const RELS = [items, orders, customers, goals];

describe("outgoing", () => {
  it("lists the relationships that leave a dataset from its many side", () => {
    expect(outgoing(RELS, "orders")).toEqual([orders]);
    expect(outgoing(RELS, "regions")).toEqual([]);
    expect(outgoing(RELS, "nope")).toEqual([]);
    expect(outgoing([rel("a.x", "b.id"), rel("a.y", "c.id")], "a")).toHaveLength(2);
  });
});

describe("pathToOne", () => {
  it("is empty from a dataset to itself", () => {
    expect(pathToOne(RELS, "orders", "orders")).toEqual([]);
    expect(pathToOne([], "x", "x")).toEqual([]);
  });

  it("follows the steps one after the other", () => {
    expect(pathToOne(RELS, "orders", "customers")).toEqual([orders]);
    expect(pathToOne(RELS, "items", "regions")).toEqual([items, orders, customers]);
  });

  it("is null when the target is not reachable, and never goes from the one side to the many side", () => {
    expect(pathToOne(RELS, "customers", "orders")).toBeNull();
    expect(pathToOne(RELS, "goals", "customers")).toBeNull();
    expect(pathToOne(RELS, "orders", "nope")).toBeNull();
  });

  it("ends on a graph with a cycle", () => {
    const loop = [rel("a.x", "b.id"), rel("b.y", "a.id")];
    expect(pathToOne(loop, "a", "b")).toEqual([loop[0]]);
    expect(pathToOne(loop, "a", "c")).toBeNull();
  });
});

describe("reachable", () => {
  it("lists the datasets through many→one steps, the start first", () => {
    expect(reachable(RELS, "items")).toEqual(["items", "orders", "customers", "regions"]);
    expect(reachable(RELS, "goals")).toEqual(["goals", "regions"]);
    expect(reachable(RELS, "regions")).toEqual(["regions"]);
    expect(reachable([], "alone")).toEqual(["alone"]);
  });

  it("lists a dataset once, however it is reached", () => {
    const loop = [rel("a.x", "b.id"), rel("b.y", "a.id")];
    expect(reachable(loop, "a")).toEqual(["a", "b"]);
  });
});

describe("conflict", () => {
  it("accepts a relationship that leaves the graph a tree, also two facts sharing a dimension", () => {
    expect(conflict([], orders)).toBeNull();
    expect(conflict([items, orders], customers)).toBeNull();
    expect(conflict([customers], goals)).toBeNull();
    expect(conflict([rel("sales.product_id", "products.id")], rel("goals.product_id", "products.id"))).toBeNull();
  });

  it("refuses a cycle, naming the relationship and the way back", () => {
    expect(conflict([orders], rel("customers.last_order", "orders.id"))).toBe(
      "this relationship creates a cycle: customers.last_order → orders.id and, the other way, orders.customer_id → customers.id",
    );
    expect(conflict([orders, customers], rel("regions.top", "orders.id"))).toContain("orders.customer_id → customers.id then customers.region_id → regions.id");
  });

  it("refuses a second relationship between the same two datasets", () => {
    expect(conflict([orders], rel("orders.ship_id", "customers.id"))).toBe(
      "this relationship gives orders a second path to customers: orders.ship_id → customers.id and orders.customer_id → customers.id",
    );
  });

  it("refuses a diamond, naming both paths", () => {
    const viaStores = [rel("orders.store_id", "stores.id"), rel("stores.region_id", "regions.id")];
    expect(conflict([orders, ...viaStores], customers)).toBe(
      "this relationship gives orders a second path to regions: orders.customer_id → customers.id then customers.region_id → regions.id" +
        " and orders.store_id → stores.id then stores.region_id → regions.id",
    );
  });

  it("finds the second path of a dataset that only reaches the new relationship through others", () => {
    // items → orders → customers; adding items.cust_id → customers.id gives items two ways to customers
    expect(conflict([items, orders], rel("items.cust_id", "customers.id"))).toContain("gives items a second path to customers");
    // adding orders → regions when items → orders → customers → regions exists
    const message = conflict([items, orders, customers], rel("orders.region_id", "regions.id"));
    expect(message).toContain("gives orders a second path to regions");
  });
});

describe("visited", () => {
  it("lists the datasets a path passes through, the start first, so that a removed one on the way is found", () => {
    expect(visited("items", pathToOne(RELS, "items", "regions")!)).toEqual(["items", "orders", "customers", "regions"]);
    expect(visited("orders", [])).toEqual(["orders"]);
  });
});

describe("a calendar's relationships", () => {
  const dated = { ...rel("orders.o_date", "dates.date"), cast: "date" as const };
  const withCalendar = [dated, rel("goals.d", "dates.date"), ...RELS];

  it("are steps like any other, the cast kept on the step", () => {
    expect(pathToOne(withCalendar, "orders", "dates")).toEqual([dated]);
    expect(pathToOne(withCalendar, "orders", "dates")![0].cast).toBe("date");
    expect(pathToOne(withCalendar, "items", "dates")).toEqual([items, dated]);
    expect(pathToOne(withCalendar, "dates", "orders")).toBeNull();
  });

  it("let two facts share the calendar, and refuse a second path to it", () => {
    expect(conflict([dated], rel("goals.d", "dates.date"))).toBeNull();
    expect(conflict([dated, orders], rel("orders.other_date", "dates.date"))).toContain("gives orders a second path to dates");
  });
});
