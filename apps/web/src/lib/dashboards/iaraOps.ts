/** What Iara may do to a dashboard, checked before the user sees it and applied once they approve (pure). */

import { missingLink } from "@/features/dashboards/editor/relationships";
import { applyEdits } from "@/lib/iara/edits";
import type { DashboardOp, IaraFileContext } from "@/lib/iara/protocol";
import { checkModel } from "@/lib/model/check";

import { checkLayout } from "./layout";
import { DATASET_NAME, datasetStatement } from "./query";
import { checkWidget } from "./widgets";

export type DashboardContext = Extract<IaraFileContext, { surface: "dashboard" }>;

/** stands in for the id a new widget gets when it is applied */
const NEW_ID = "newwidget".slice(0, 8);

/** The model's source after the operations. Throws when an edit no longer fits it. */
export function modelAfter(source: string, ops: readonly DashboardOp[]): string {
  return ops.reduce((text, op) => {
    if (op.op === "edit_model") return applyEdits(text, op.edits);
    if (op.op !== "add_model_lines") return text;
    const open = text === "" || text.endsWith("\n") ? text : `${text}\n`;
    return `${open}${op.lines.join("\n")}\n`;
  }, source);
}

/** Why the operations cannot be applied to the dashboard as it is (empty: they can). */
export function opsProblems(ops: readonly DashboardOp[], ctx: DashboardContext): string[] {
  const problems: string[] = [];
  const names = new Set(ctx.datasets.map((d) => d.name));
  const schema: Record<string, string[] | null> = Object.fromEntries(ctx.datasets.map((d) => [d.name, d.columns?.map((c) => c.name) ?? null]));

  for (const op of ops) {
    if (op.op === "set_dataset") {
      if (!DATASET_NAME.test(op.name)) problems.push(`${op.name} is not a dataset name: lowercase letters, digits and _`);
      if (ctx.datasets.find((d) => d.name === op.name)?.recipe) problems.push(`dataset ${op.name} is made of cleaning steps, not SQL: add another dataset instead`);
      try {
        datasetStatement(op.sql);
      } catch (e) {
        problems.push(`dataset ${op.name}: ${(e as Error).message}`);
      }
      names.add(op.name);
      // its columns may be others now
      schema[op.name] = null;
    } else if (op.op === "remove_dataset") {
      if (!names.delete(op.name)) problems.push(`there is no dataset ${op.name}`);
      delete schema[op.name];
    }
  }

  let source = ctx.model;
  try {
    source = modelAfter(ctx.model, ops);
  } catch (e) {
    problems.push(`model: ${(e as Error).message}`);
  }
  const errors = (text: string) => checkModel(text, schema).diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
  const before = new Set(errors(ctx.model));
  problems.push(...errors(source).filter((m) => !before.has(m)).map((m) => `model: ${m}`));
  const { model } = checkModel(source, schema);

  const ids = new Set(ctx.widgets.map((w) => w.id));
  for (const op of ops) {
    if (op.op === "remove_widget" && !ids.delete(op.id)) problems.push(`there is no widget ${op.id}`);
    if (op.op === "move_widget" || (op.op === "set_widget" && op.id !== null)) {
      if (op.id !== null && !ids.has(op.id)) problems.push(`there is no widget ${op.id}`);
    }
    const place = op.op === "move_widget" ? op : op.op === "set_widget" ? op.place : undefined;
    if (place) {
      try {
        checkLayout([{ widget: NEW_ID, x: place.x, y: place.y, w: place.w, h: place.h }]);
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    if (op.op !== "set_widget") continue;
    try {
      const w = checkWidget(op.id ?? NEW_ID, op.widget);
      if (w.kind === "chart" || w.kind === "table") {
        if (!names.has(w.dataset)) problems.push(`there is no dataset ${w.dataset}`);
      }
      if (w.kind === "chart") {
        for (const v of w.values ?? []) if (!names.has(v.dataset)) problems.push(`there is no dataset ${v.dataset}`);
        for (const m of w.measures ?? []) if (!model.measures.some((x) => x.name === m)) problems.push(`there is no measure ${m}`);
      }
      const apart = missingLink(model, w, [...names]);
      if (apart) problems.push(`${apart[0]} and ${apart[1]} are not related: add a relate(...) line first`);
    } catch (e) {
      problems.push(`widget: ${(e as Error).message}`);
    }
  }
  return [...new Set(problems)];
}

/** What a change must plan on the engine: the SQL of the datasets it writes. */
export const datasetsWritten = (ops: readonly DashboardOp[]) => ops.flatMap((op) => (op.op === "set_dataset" ? [{ name: op.name, sql: op.sql }] : []));
