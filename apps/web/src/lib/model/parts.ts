/**
 * SQL under construction. The checker builds every value as `Parts`: text, and
 * wherever an aggregation goes, the aggregation itself (an `Atom`). A finished
 * measure numbers its atoms and keeps the text around them as a `Template`.
 */

import type { Atom, Measure, Template } from "./types";

export type Parts = (string | Atom)[];

/** `sql\`(${a} + ${b})\``: text and parts glued into one, neighbouring text joined so the shape is always the same */
export function sql(strings: TemplateStringsArray, ...holes: (string | Parts)[]): Parts {
  const out: Parts = [];
  const push = (p: string | Atom) => {
    if (p === "") return;
    const last = out[out.length - 1];
    if (typeof p === "string" && typeof last === "string") out[out.length - 1] = last + p;
    else out.push(p);
  };
  strings.forEach((s, i) => {
    push(s);
    const hole = holes[i];
    if (hole !== undefined) (typeof hole === "string" ? [hole] : hole).forEach(push);
  });
  return out;
}

/** The SQL of a value with no aggregation in it (a column, a constant, a calculation on them): what goes inside an aggregation. */
export function text(parts: Parts): string {
  return parts
    .map((p) => {
      if (typeof p !== "string") throw new Error("an aggregation cannot go inside another");
      return p;
    })
    .join("");
}

/** Numbers the atoms in order of first use; the same dataset and SQL is one atom, however often it is written. */
export function numbered(parts: Parts): { atoms: Atom[]; expr: Template } {
  const atoms: Atom[] = [];
  const expr = parts.map((p) => {
    if (typeof p === "string") return p;
    let i = atoms.findIndex((a) => a.dataset === p.dataset && a.sql === p.sql);
    if (i < 0) i = atoms.push({ dataset: p.dataset, sql: p.sql }) - 1;
    return { atom: i };
  });
  return { atoms, expr };
}

/** A measure back as parts, to be used inside another measure. */
export function partsOf(m: Pick<Measure, "atoms" | "expr">): Parts {
  return m.expr.map((p) => (typeof p === "string" ? p : m.atoms[p.atom]));
}

/** A template as SQL text, each atom written by `atomSql(index)`. */
export function render(t: Template, atomSql: (atom: number) => string): string {
  return t.map((p) => (typeof p === "string" ? p : atomSql(p.atom))).join("");
}
