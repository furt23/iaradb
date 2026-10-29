/** What the model editors offer while a measure is typed (pure). */

import type { CompletionItem, Completions } from "@iara/protocol";

import { CALENDAR_COLUMNS, type Model, type Schema } from "@/lib/model/types";

export interface ModelNames {
  model: Pick<Model, "measures" | "calendars" | "params">;
  /** column names by dataset (null: not read yet) */
  schema: Schema;
  functions: readonly { name: string; signature: string; doc: string }[];
  /** the language of the labels and docs: English keys in */
  t(key: string): string;
}

const WORD = /\w/;

/** Whether the cursor is in a `# comment` or a string of its line: nothing to complete there. */
function inCommentOrString(code: string, cursor: number): boolean {
  let quote = "";
  for (const c of code.slice(code.lastIndexOf("\n", cursor - 1) + 1, cursor)) {
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === "#") {
      return true;
    } else if (c === '"' || c === "'") {
      quote = c;
    }
  }
  return quote !== "";
}

function members(owner: string, { model, schema }: ModelNames): CompletionItem[] {
  const columns = Object.hasOwn(schema, owner) ? (schema[owner] ?? []) : model.calendars.some((c) => c.name === owner) ? CALENDAR_COLUMNS : [];
  return columns.map((label) => ({ label, type: "property" }));
}

function names({ model, schema, functions, t }: ModelNames): CompletionItem[] {
  return [
    ...model.measures.map((m) => ({ label: m.name, type: "variable", detail: t("Measure") })),
    ...Object.keys(schema).map((label) => ({ label, type: "class", detail: t("Dataset") })),
    ...model.calendars.map((c) => ({ label: c.name, type: "namespace", detail: t("Calendar") })),
    ...model.params.map((p) => ({ label: p.name, type: "constant", detail: `${t("Parameter")} = ${JSON.stringify(p.default)}` })),
    ...functions.map((f) => ({ label: f.name, type: "function", detail: f.signature, signature: f.signature, doc: t(f.doc) })),
  ];
}

/**
 * The completions at `cursor`: the columns of a dataset (or the calendar's) after
 * its name and a dot, else the measures, datasets, calendars, params and functions.
 */
export function modelCompletions(code: string, cursor: number, ctx: ModelNames): Completions {
  let from = cursor;
  while (from > 0 && WORD.test(code[from - 1])) from--;
  if (inCommentOrString(code, cursor)) return { from, items: [] };
  if (code[from - 1] !== ".") return { from, items: names(ctx) };
  let start = from - 1;
  while (start > 0 && WORD.test(code[start - 1])) start--;
  return { from, items: members(code.slice(start, from - 1), ctx) };
}
