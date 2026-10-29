/**
 * Stage 3: reads model.py and checks it against the datasets' columns. One
 * line at a time: a line with an error is reported and left out, the rest of
 * the file still checks, so the editor can show every problem at once.
 *
 * In two passes. The first reads the lines that declare what the measures
 * stand on (`relate`, `name = calendar(...)`, `name = param(...)`), in file
 * order; the second checks the measures, which can then use a calendar or a
 * param written further down.
 */

import type { AssignStmt, Call, ExprStmt, ImportStmt, Stmt } from "./ast";
import { checkExpr, exprContext, type Entry, type Env } from "./expr";
import { fail, ModelError, type FnDef } from "./functions/def";
import { FUNCTIONS, PLANNED } from "./functions/registry";
import { ALLOWED, parse } from "./parse";
import { numbered, text } from "./parts";
import { CALENDAR_COLUMNS, type Calendar, type Checked, type Diagnostic, type Measure, type Param, type Relationship, type Schema } from "./types";

const MODULE = "iara.model";

/** The function a statement's call is of, if it is a call. */
function calling(stmt: Stmt): { call: Call; def: FnDef | undefined } | undefined {
  const e = stmt.kind === "expr" ? stmt.expr : stmt.kind === "assign" ? stmt.value : undefined;
  return e?.kind === "call" ? { call: e, def: FUNCTIONS.get(e.func) } : undefined;
}

/** Does the first pass take this line? */
function declares(stmt: Stmt): boolean {
  const c = calling(stmt);
  if (!c?.def) return false;
  return stmt.kind === "expr" ? c.def.kind === "statement" : c.def.kind === "declaration" || c.def.name === "param";
}

/** Checks the model source against `schema` (column names by dataset). Never throws. */
export function checkModel(source: string, schema: Schema): Checked {
  const { statements, diagnostics } = parse(source);
  const names = new Map<string, Entry>();
  const measures: Measure[] = [];
  const relationships: Relationship[] = [];
  const calendars: Calendar[] = [];
  const params: Param[] = [];
  // the datasets, and the ones calendars make
  const known: Schema = { ...schema };
  const env: Env = { schema: known, names, relationships, calendars, params };

  const reserved = (name: string) => Object.hasOwn(known, name) || FUNCTIONS.has(name) || PLANNED.has(name);

  function importing(stmt: ImportStmt) {
    if (stmt.module !== MODULE) {
      diagnostics.push({ ...stmt.moduleSpan, severity: "error", message: `only \`${MODULE}\` can be imported, not \`${stmt.module}\`` });
      return;
    }
    for (const n of stmt.names) {
      if (FUNCTIONS.has(n.name)) continue;
      const message = PLANNED.has(n.name) ? `${n.name} is not available yet` : `${MODULE} has no ${n.name}`;
      diagnostics.push({ ...n.span, severity: "error", message });
    }
  }

  function relating(stmt: ExprStmt) {
    const e = stmt.expr;
    const def = e.kind === "call" ? FUNCTIONS.get(e.func) : undefined;
    if (e.kind !== "call" || def?.kind !== "statement") return fail(e, ALLOWED);
    relationships.push(def.check(e, exprContext(env)));
  }

  /** The name a line gives must be free; `earlier`: the names the lines before it use (the first pass reads out of order). */
  function claim(stmt: AssignStmt, earlier: ReadonlySet<string> = new Set()) {
    const { name } = stmt;
    const target = { span: stmt.nameSpan };
    if (Object.hasOwn(known, name)) fail(target, `\`${name}\` is a dataset name: pick another name`);
    if (FUNCTIONS.has(name)) fail(target, `\`${name}\` is a function name: pick another name`);
    if (PLANNED.has(name)) fail(target, `\`${name}\` is kept for a function that is not available yet: pick another name`);
    if (names.has(name) || earlier.has(name)) fail(target, `\`${name}\` is already defined`);
  }

  function assigning(stmt: AssignStmt, earlier?: ReadonlySet<string>) {
    const { name } = stmt;
    claim(stmt, earlier);

    try {
      const t = checkExpr(stmt.value, env, true, name);
      const value = { span: stmt.value.span };
      if (t.level === "row") fail(value, `\`${name}\` is a value per row: wrap it in an aggregation, e.g. sum(...)`);
      if (t.level === "scalar") {
        // a constant: used by name, it is written out where it is used
        names.set(name, { kind: "const", sql: text(t.sql), text: t.text });
        return;
      }
      const { atoms, expr } = numbered(t.sql);
      const measure: Measure = {
        name,
        datasets: [...new Set(atoms.map((a) => a.dataset))],
        atoms,
        expr,
        ...(t.format && { format: t.format }),
        ...(t.label !== undefined && { label: t.label }),
        span: stmt.span,
      };
      names.set(name, { kind: "measure", measure });
      measures.push(measure);
    } catch (e) {
      names.set(name, { kind: "broken" });
      throw e;
    }
  }

  /** `name = calendar(...)`: the name becomes a dataset, tied to its columns by relationships. */
  function calendaring(stmt: AssignStmt, call: Call, def: Extract<FnDef, { kind: "declaration" }>, earlier: ReadonlySet<string>) {
    claim(stmt, earlier);
    try {
      const made = def.check(call, exprContext(env), stmt.name);
      calendars.push(made.calendar);
      relationships.push(...made.relationships);
      known[stmt.name] = [...CALENDAR_COLUMNS];
    } catch (e) {
      names.set(stmt.name, { kind: "broken" });
      throw e;
    }
  }

  function run(stmt: Stmt) {
    switch (stmt.kind) {
      case "import":
        return importing(stmt);
      case "expr":
        return relating(stmt);
      case "assign":
        return assigning(stmt);
      case "invalid":
        // its line did not parse: a later use of its name is "has an error", not "unknown name"
        if (stmt.name && !reserved(stmt.name) && !names.has(stmt.name)) names.set(stmt.name, { kind: "broken" });
    }
  }

  function attempt(stmt: Stmt, f: () => void) {
    try {
      f();
    } catch (e) {
      const at = e instanceof ModelError ? e.span : stmt.span;
      const message = e instanceof ModelError ? e.message : `this line could not be checked (${e instanceof Error ? e.message : String(e)})`;
      diagnostics.push({ ...at, severity: "error", message } satisfies Diagnostic);
    }
  }

  /** a line of the first pass */
  function declare(stmt: Stmt, earlier: ReadonlySet<string>) {
    if (stmt.kind === "expr") return relating(stmt);
    const { call, def } = calling(stmt)!;
    if (stmt.kind === "assign" && def?.kind === "declaration") calendaring(stmt, call, def, earlier);
    else if (stmt.kind === "assign") assigning(stmt, earlier);
  }

  const first = new Set(statements.filter(declares));
  const earlier = new Set<string>();
  for (const stmt of statements) {
    if (first.has(stmt)) attempt(stmt, () => declare(stmt, earlier));
    if ((stmt.kind === "assign" || stmt.kind === "invalid") && stmt.name) earlier.add(stmt.name);
  }
  for (const stmt of statements) if (!first.has(stmt)) attempt(stmt, () => run(stmt));

  diagnostics.sort((a, b) => a.from - b.from);
  return { model: { relationships, measures, calendars, params: params.sort((a, b) => a.span.from - b.span.from) }, diagnostics };
}
