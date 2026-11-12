/**
 * Edits to the text of a dashboard's model.py (pure). The model is parsed by
 * our parser and never run, so each edit works on offsets of the source: the
 * text it does not change, comments and spacing included, stays as it was.
 */

import type { NumberFormat } from "@/lib/dashboards/types";
import type { AssignStmt, Call } from "@/lib/model/ast";
import { lex, type Token } from "@/lib/model/lex";
import { parse } from "@/lib/model/parse";
import type { Relationship } from "@/lib/model/types";

/** The keyword arguments of `measure()` that describe its number format. */
const FORMAT_KEYS = new Set(["format", "decimals", "currency", "compact"]);

/** A call argument: its span, and its keyword when it has one. */
interface Item {
  from: number;
  to: number;
  key?: string;
}

/** The offset of the line break that ends the line at `at`, or the source's end when it has none. */
function lineEnd(source: string, at: number): number {
  const nl = source.indexOf("\n", at);
  return nl < 0 ? source.length : nl;
}

/**
 * Where the statement that defines `name` starts and ends. It is the first
 * definition, as the checker reads them. A line that did not parse runs to its
 * end, so a broken measure goes with the rest of its line.
 */
function definitionOf(source: string, name: string): { from: number; to: number } | null {
  const stmt = parse(source).statements.find((s) => (s.kind === "assign" || s.kind === "invalid") && s.name === name);
  if (!stmt) return null;
  if (stmt.kind === "invalid") return { from: stmt.span.from, to: lineEnd(source, stmt.span.to) };
  return { from: stmt.span.from, to: stmt.span.to };
}

/** The text of the statement that defines `name` (`source.slice(span.from, span.to)`), or null. */
export function measureText(source: string, name: string): string | null {
  const at = definitionOf(source, name);
  return at ? source.slice(at.from, at.to) : null;
}

/** The source with the statement that defines `name` replaced by `text`; throws when there is none. */
export function replaceMeasure(source: string, name: string, text: string): string {
  const at = definitionOf(source, name);
  if (!at) throw new Error(`no measure named \`${name}\` in the model`);
  return source.slice(0, at.from) + text + source.slice(at.to);
}

/**
 * The source without the statement that defines `name` and the line break after
 * it; throws when there is none. Lines are removed whole, so the others keep theirs.
 */
export function removeMeasure(source: string, name: string): string {
  const at = definitionOf(source, name);
  if (!at) throw new Error(`no measure named \`${name}\` in the model`);
  return source.slice(0, at.from) + source.slice(lineEnd(source, at.to) + 1);
}

/** The source without the line of a `relate(...)`. */
export function removeRelationship(source: string, rel: Pick<Relationship, "span">): string {
  return source.slice(0, rel.span.from) + source.slice(lineEnd(source, rel.span.to) + 1);
}

const isOp = (t: Token | undefined, text: string) => t?.kind === "op" && t.text === text;

/**
 * Offsets of the tokens that are the bare name `name`: an assignment target or
 * a name in an expression. Not an attribute (after a `.`), not a called
 * function, not a keyword argument, not in an import. The lexer's tokens are
 * used, so a line with errors is renamed too and strings and comments never are.
 */
function bareNameOffsets(source: string, name: string): number[] {
  const toks = lex(source);
  const offsets: number[] = [];
  let inImport = false;
  toks.forEach((t, i) => {
    const prev: Token | undefined = toks[i - 1];
    if (!prev || prev.kind === "newline") inImport = t.kind === "name" && t.text === "from";
    if (t.kind !== "name" || t.text !== name || inImport) return;
    const keywordArg = isOp(toks[i + 1], "=") && (isOp(prev, "(") || isOp(prev, ","));
    if (isOp(prev, ".") || isOp(toks[i + 1], "(") || keywordArg) return;
    offsets.push(t.from);
  });
  return offsets;
}

/** The source with the bare name `from` renamed to `to` (see bareNameOffsets). */
export function renameInSource(source: string, from: string, to: string): string {
  let out = "";
  let last = 0;
  for (const at of bareNameOffsets(source, from)) {
    out += source.slice(last, at) + to;
    last = at + from.length;
  }
  return out + source.slice(last);
}

/** The one `name = expression` statement `line` holds; throws for anything else. */
function assignmentOf(line: string): AssignStmt {
  const { statements, diagnostics } = parse(line);
  const stmt = statements[0];
  if (diagnostics.length > 0 || statements.length !== 1 || stmt.kind !== "assign") {
    throw new Error("withFormat needs one `name = expression` line");
  }
  return stmt;
}

/** The keywords of a number format, in the order the model's docs give; `currency` only with its style. */
function formatKeywords(f: NumberFormat): string {
  const keys = [`format="${f.style}"`];
  if (f.decimals !== undefined) keys.push(`decimals=${f.decimals}`);
  if (f.style === "currency" && f.currency !== undefined) keys.push(`currency="${f.currency}"`);
  if (f.compact !== undefined) keys.push(`compact=${f.compact ? "True" : "False"}`);
  return keys.join(", ");
}

/**
 * The text between item `i` and the next one (the comma and any line break or
 * comment). The last item borrows the separator before it, so a keyword added
 * after it keeps the call's layout.
 */
function separator(line: string, items: Item[], i: number): string {
  if (i + 1 < items.length) return line.slice(items[i].to, items[i + 1].from);
  return i > 0 ? line.slice(items[i - 1].to, items[i].from) : ", ";
}

/**
 * A `measure(...)` value with its format keywords replaced by `group` ("" for
 * none), in place: the other arguments keep their text and layout. When only
 * the expression is left, the call is unwrapped to the bare expression.
 */
function rewriteMeasure(line: string, call: Call, group: string): string {
  const items: Item[] = [
    ...call.args.map((a) => ({ from: a.span.from, to: a.span.to })),
    ...call.kwargs.map((k) => ({ from: k.span.from, to: k.span.to, key: k.name })),
  ];
  const expr = call.args[0] ?? call.kwargs.find((k) => k.name === "expr")?.value;
  if (!expr) throw new Error("measure() needs an expression");

  const isFormat = (item: Item) => item.key !== undefined && FORMAT_KEYS.has(item.key);
  const firstFormat = items.findIndex(isFormat);
  // the new keywords take the place of the first old one; with none, they go last
  const pieces: { text: string; sep: string }[] = [];
  items.forEach((item, i) => {
    if (!isFormat(item)) pieces.push({ text: line.slice(item.from, item.to), sep: separator(line, items, i) });
    else if (i === firstFormat && group) pieces.push({ text: group, sep: separator(line, items, i) });
  });
  if (firstFormat < 0 && group) pieces.push({ text: group, sep: ", " });

  if (pieces.length === 1) return line.slice(0, call.span.from) + line.slice(expr.span.from, expr.span.to) + line.slice(call.span.to);

  // the call's own parentheses: a parenthesized measure has its span widened
  const open = line.indexOf("(", call.funcSpan.to);
  const last = items[items.length - 1].to;
  const close = lex(line).find((t) => t.kind === "op" && t.text === ")" && t.from >= last)!.from;
  const body = pieces.map((p, k) => (k + 1 < pieces.length ? p.text + p.sep : p.text)).join("");
  return line.slice(0, open + 1) + line.slice(open + 1, items[0].from) + body + line.slice(last, close) + line.slice(close);
}

/**
 * `name = expr` with its number format set; `null` removes it. A `measure(...)`
 * value keeps its other arguments; a plain value is wrapped as
 * `measure(value, format=...)`. Throws when `line` is not one such statement.
 */
export function withFormat(line: string, format: NumberFormat | null): string {
  const { value } = assignmentOf(line);
  const group = format ? formatKeywords(format) : "";
  if (value.kind === "call" && value.func === "measure") return rewriteMeasure(line, value, group);
  if (!format) return line;
  return `${line.slice(0, value.span.from)}measure(${line.slice(value.span.from, value.span.to)}, ${group})${line.slice(value.span.to)}`;
}
