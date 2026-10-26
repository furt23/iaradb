import type { Cell } from "@iara/protocol";

export interface FindOptions {
  text: string;
  matchCase: boolean;
  regex: boolean;
  word: boolean;
}

export interface Match {
  cellId: string;
  index: number;
  length: number;
}

/** The search as a global RegExp: null when there is nothing to look for or the expression is invalid. */
export function findRegExp(o: FindOptions): RegExp | null {
  if (!o.text) return null;
  const body = o.regex ? o.text : o.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(o.word ? `\\b(?:${body})\\b` : body, o.matchCase ? "gm" : "gim");
  } catch {
    return null;
  }
}

/** Every match in the cells' code, in notebook order. Empty matches are skipped. */
export function findMatches(cells: Cell[], re: RegExp | null): Match[] {
  if (!re) return [];
  return cells.flatMap((c) => [...c.code.matchAll(re)].filter((m) => m[0]).map((m) => ({ cellId: c.id, index: m.index, length: m[0].length })));
}

/** `code` with the match at `index` replaced (a regex replacement may use $1, $&). */
export function replaceAt(code: string, index: number, o: FindOptions, replacement: string): string {
  const re = findRegExp(o);
  if (!re) return code;
  // sticky and not global: String.replace changes only the match that starts at lastIndex
  const here = new RegExp(re.source, re.flags.replace("g", "y"));
  here.lastIndex = index;
  return o.regex ? code.replace(here, replacement) : code.replace(here, () => replacement);
}

/** The new code of each cell the replacement changes, by cell id. */
export function replaceAll(cells: Cell[], o: FindOptions, replacement: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const cell of cells) {
    // last to first: the matches before keep their index
    const found = findMatches([cell], findRegExp(o)).reverse();
    if (found.length) out.set(cell.id, found.reduce((code, m) => replaceAt(code, m.index, o, replacement), cell.code));
  }
  return out;
}
