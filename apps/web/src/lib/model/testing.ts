/** Models built by hand for the compiler's tests: they do not depend on the checker, which writes the same shapes. */

import type { Atom, Calendar, Measure, Model, Relationship, Template } from "./types";

export const span = { from: 0, to: 0, line: 1, col: 1 };

/** `rel("orders.customer_id", "customers.id")`; `cast`: the many side is compared as a DATE */
export function rel(many: string, one: string, cast?: "date"): Relationship {
  const [md, mc] = many.split(".");
  const [od, oc] = one.split(".");
  return { many: { dataset: md, column: mc }, one: { dataset: od, column: oc }, span, ...(cast && { cast }) };
}

/** `atom("orders", "SUM(\"a\")", "sum", { window })` */
export const atom = (dataset: string, sql: string, agg: Atom["agg"], rest: Partial<Atom> = {}): Atom => ({ dataset, sql, agg, ...rest });

/** `sum("orders", "a")` is SUM("a") over orders */
export const sum = (dataset: string, column: string, rest: Partial<Atom> = {}): Atom => atom(dataset, `SUM("${column}")`, "sum", rest);

export function measure(name: string, atoms: Atom[], expr: Template = [{ atom: 0 }]): Measure {
  return { name, datasets: [...new Set(atoms.map((a) => a.dataset))], atoms, expr, span };
}

/** `calendar("dates", "orders.day", "goals.day")` */
export function calendar(name: string, ...columns: string[]): Calendar {
  return { name, columns: columns.map((c) => ({ dataset: c.split(".")[0], column: c.split(".")[1] })), span };
}

export const model = (parts: Partial<Model>): Model => ({ relationships: [], measures: [], calendars: [], params: [], ...parts });
