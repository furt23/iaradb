/**
 * Stage 3: reads model.py and checks it against the datasets' columns. One
 * line at a time: a line with an error is reported and left out, the rest of
 * the file still checks, so the editor can show every problem at once.
 */

import type { AssignStmt, ExprStmt, ImportStmt, Stmt } from "./ast";
import { checkExpr, exprContext, type Entry, type Env } from "./expr";
import { fail, ModelError } from "./functions/def";
import { FUNCTIONS, PLANNED } from "./functions/registry";
import { ALLOWED, parse } from "./parse";
import type { Checked, Diagnostic, Measure, Relationship, Schema } from "./types";

const MODULE = "iara.model";

/** `a`, `a and b`, `a, b and c` */
function list(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Checks the model source against `schema` (column names by dataset). Never throws. */
export function checkModel(source: string, schema: Schema): Checked {
  const { statements, diagnostics } = parse(source);
  const names = new Map<string, Entry>();
  const measures: Measure[] = [];
  const relationships: Relationship[] = [];
  const env: Env = { schema, names, relationships };

  const reserved = (name: string) => Object.hasOwn(schema, name) || FUNCTIONS.has(name) || PLANNED.has(name);

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

  function assigning(stmt: AssignStmt) {
    const { name } = stmt;
    const target = { span: stmt.nameSpan };
    if (Object.hasOwn(schema, name)) fail(target, `\`${name}\` is a dataset name: pick another name`);
    if (FUNCTIONS.has(name)) fail(target, `\`${name}\` is a function name: pick another name`);
    if (PLANNED.has(name)) fail(target, `\`${name}\` is kept for a function that is not available yet: pick another name`);
    if (names.has(name)) fail(target, `\`${name}\` is already defined`);

    try {
      const t = checkExpr(stmt.value, env, true);
      const value = { span: stmt.value.span };
      if (t.level === "row") fail(value, `\`${name}\` is a value per row: wrap it in an aggregation, e.g. sum(...)`);
      if (t.level === "scalar") {
        // a constant: used by name, it is written out where it is used
        names.set(name, { kind: "const", sql: t.sql, text: t.text });
        return;
      }
      if (t.datasets.length === 0) fail(value, `\`${name}\` does not read any dataset: aggregate a column, e.g. sum(orders.total)`);
      if (t.datasets.length > 1) fail(value, `\`${name}\` reads ${list(t.datasets)}: a measure reads one dataset for now`);
      const measure: Measure = {
        name,
        dataset: t.datasets[0],
        sql: t.sql,
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

  for (const stmt of statements) {
    try {
      run(stmt);
    } catch (e) {
      const at = e instanceof ModelError ? e.span : stmt.span;
      const message = e instanceof ModelError ? e.message : `this line could not be checked (${e instanceof Error ? e.message : String(e)})`;
      diagnostics.push({ ...at, severity: "error", message } satisfies Diagnostic);
    }
  }

  diagnostics.sort((a, b) => a.from - b.from);
  return { model: { relationships, measures }, diagnostics };
}
