import { describe, expect, it } from "vitest";

import { checkModelLayout, parseModelLayout } from "@/lib/dashboards/modelLayout";

import { autoLayout, CARD_WIDTH, cardHeight, columnY, dropTarget, HEADER_HEIGHT, linkEnds, linkPath, MAX_VISIBLE_ROWS, ROW_HEIGHT, withPlaces } from "./diagramLayout";

const rel = (many: string, one: string) => ({ many: { dataset: many, column: "k" }, one: { dataset: one, column: "k" } });
const rows = () => 3;

describe("autoLayout", () => {
  const places = autoLayout(["nation", "orders", "customer", "lonely"], [rel("orders", "customer"), rel("customer", "nation")], rows);

  it("puts each table to the right of those that point at it", () => {
    expect(places.orders.x).toBeLessThan(places.customer.x);
    expect(places.customer.x).toBeLessThan(places.nation.x);
    expect(places.customer.x - places.orders.x).toBeGreaterThanOrEqual(CARD_WIDTH);
  });

  it("stacks the tables of a column without overlap", () => {
    expect(places.lonely.x).toBe(places.orders.x);
    expect(Math.abs(places.lonely.y - places.orders.y)).toBeGreaterThanOrEqual(cardHeight(3));
  });

  it("ends on a cycle", () => {
    const c = autoLayout(["a", "b"], [rel("a", "b"), rel("b", "a")], rows);
    expect(Object.keys(c)).toEqual(["a", "b"]);
  });
});

describe("withPlaces", () => {
  it("keeps what was placed, and finds a free place below for a new table", () => {
    const places = withPlaces({ orders: { x: 500, y: 300 } }, ["orders", "customer"], [], rows);
    expect(places.orders).toEqual({ x: 500, y: 300 });
    expect(places.customer.y).toBeGreaterThanOrEqual(300 + cardHeight(3));
  });

  it("drops the place of a table no longer there", () => {
    expect(Object.keys(withPlaces({ gone: { x: 1, y: 1 } }, ["orders"], [], rows))).toEqual(["orders"]);
  });
});

describe("columnY", () => {
  it("is the middle of the column's row", () => {
    expect(columnY(100, 3, 1)).toBe(100 + HEADER_HEIGHT + 1.5 * ROW_HEIGHT);
  });

  it("follows the table's scroll, staying inside the table", () => {
    expect(columnY(0, 50, 2, ROW_HEIGHT)).toBe(HEADER_HEIGHT + 1.5 * ROW_HEIGHT);
    expect(columnY(0, 50, 0, 500)).toBe(HEADER_HEIGHT);
    expect(columnY(0, 50, 40)).toBe(HEADER_HEIGHT + MAX_VISIBLE_ROWS * ROW_HEIGHT);
  });
});

describe("dropTarget", () => {
  const from = { dataset: "orders" };

  it("is a column of another table", () => {
    expect(dropTarget(from, { table: "customer", column: "id" })).toEqual({ dataset: "customer", column: "id" });
  });

  it("is nothing outside a row, on the same table, or on a calendar", () => {
    expect(dropTarget(from, undefined)).toBeNull();
    expect(dropTarget(from, {})).toBeNull();
    expect(dropTarget(from, { table: "orders", column: "id" })).toBeNull();
    expect(dropTarget(from, { table: "dates", column: "year", calendar: "true" })).toBeNull();
  });
});

describe("the line between two tables", () => {
  it("joins the sides that face each other", () => {
    expect(linkEnds(0, 400)).toEqual({ a: "right", b: "left" });
    expect(linkEnds(400, 0)).toEqual({ a: "left", b: "right" });
    expect(linkEnds(0, 50)).toEqual({ a: "right", b: "right" });
  });

  it("leaves each table straight out of its side", () => {
    expect(linkPath({ x: 0, y: 0 }, "right", { x: 200, y: 50 }, "left")).toBe("M 0 0 C 60 0, 140 50, 200 50");
  });
});

describe("the saved places", () => {
  it("keeps numbers from 0 up, as whole pixels", () => {
    expect(checkModelLayout({ orders: { x: 10.6, y: 0 } })).toEqual({ orders: { x: 11, y: 0 } });
    expect(Object.keys(parseModelLayout('{"__proto__":{"x":1,"y":1}}'))).toEqual(["__proto__"]);
  });

  it.each([[[]], [{ a: 1 }], [{ a: { x: -1, y: 0 } }], [{ a: { x: "1", y: 0 } }]])("refuses %j", (bad) => {
    expect(() => checkModelLayout(bad)).toThrow();
  });
});
