/**
 * SQL under construction. The checker builds every value as `Parts`: text, and
 * wherever an aggregation goes, the aggregation itself (an `Atom`), or a rank
 * of some parts. A finished measure numbers its atoms and keeps the text
 * around them as a `Template`.
 */

import type { Atom, Measure, Template } from "./types";

export type Part = string | Atom | { rank: Parts };
export type Parts = Part[];

/** `sql\`(${a} + ${b})\``: text and parts glued into one, neighbouring text joined so the shape is always the same */
export function sql(strings: TemplateStringsArray, ...holes: (string | Parts)[]): Parts {
  const out: Parts = [];
  const push = (p: Part) => {
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

/** Is there a rank in these parts? (calculate and the windows do not reach through one.) */
export function hasRank(parts: Parts): boolean {
  return parts.some((p) => typeof p === "object" && "rank" in p);
}

/** The same parts with each atom replaced by `f(atom)`; text is kept (ranks are not entered). */
export function mapAtoms(parts: Parts, f: (atom: Atom) => Atom): Parts {
  return parts.map((p) => (typeof p === "string" || "rank" in p ? p : f(p)));
}

const sorted = (xs: readonly object[]) => xs.map((x) => JSON.stringify(x)).sort();

/** What makes two atoms one: the same value, in the same context and window (the order of a context's entries does not matter). */
function atomKey(a: Atom): string {
  const c = a.context;
  return JSON.stringify([a.dataset, a.sql, a.agg, c && [sorted(c.filters), sorted(c.removed)], a.window]);
}

/** Numbers the atoms in order of first use; the same atom is one, however often it is written. */
export function numbered(parts: Parts): { atoms: Atom[]; expr: Template } {
  const atoms: Atom[] = [];
  const keys: string[] = [];
  const walk = (ps: Parts): Template =>
    ps.map((p) => {
      if (typeof p === "string") return p;
      if ("rank" in p) return { rank: walk(p.rank) };
      const key = atomKey(p);
      let i = keys.indexOf(key);
      if (i < 0) {
        i = atoms.push({ ...p }) - 1;
        keys.push(key);
      }
      return { atom: i };
    });
  return { atoms, expr: walk(parts) };
}

/** A measure back as parts, to be used inside another measure. */
export function partsOf(m: Pick<Measure, "atoms" | "expr">): Parts {
  const back = (t: Template): Parts => t.map((p) => (typeof p === "string" ? p : "atom" in p ? m.atoms[p.atom] : { rank: back(p.rank) }));
  return back(m.expr);
}

/**
 * A template as SQL text, each atom written by `atomSql(index)` and each rank
 * by `rankSql(inner)` over the SQL of what it ranks (a template with a rank
 * needs one).
 */
export function render(t: Template, atomSql: (atom: number) => string, rankSql?: (inner: string) => string): string {
  return t
    .map((p) => {
      if (typeof p === "string") return p;
      if ("atom" in p) return atomSql(p.atom);
      if (!rankSql) throw new Error("this template has a rank: render needs rankSql");
      return rankSql(render(p.rank, atomSql, rankSql));
    })
    .join("");
}
