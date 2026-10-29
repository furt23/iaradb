/** Lines added to the model's source from the widget settings (pure). */

import { checkModel } from "@/lib/model/check";
import type { Schema } from "@/lib/model/types";

/** The source ending in a line break, ready for more lines (an empty source stays empty). */
function open(source: string): string {
  return source === "" || source.endsWith("\n") ? source : `${source}\n`;
}

/** The source with `lines` after it, one each. */
export function appendLines(source: string, lines: string[]): string {
  return `${open(source)}${lines.join("\n")}\n`;
}

export interface AddedCheck {
  /** the problems found in the added text, positioned in it */
  diagnostics: { from: number; to: number; severity: "error" | "warning"; message: string }[];
  /** the last measure the added text defines (not one the source had) */
  measure: string | undefined;
  /** it checks and defines a new measure */
  ok: boolean;
}

/** Checks `added` as it would stand after the source: only what is found in `added` counts. */
export function checkAdded(source: string, added: string, schema: Schema): AddedCheck {
  const head = open(source);
  const { model, diagnostics } = checkModel(`${head}${added}`, schema);
  const base = head.length;
  const found = diagnostics.filter((d) => d.from >= base).map(({ from, to, severity, message }) => ({ from: from - base, to: to - base, severity, message }));
  const measure = model.measures.filter((m) => m.span.from >= base).at(-1)?.name;
  return { diagnostics: found, measure, ok: measure !== undefined && !found.some((d) => d.severity === "error") };
}
