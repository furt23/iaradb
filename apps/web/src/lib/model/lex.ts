/**
 * Stage 1: source text to tokens. A problem the lexer finds (bad string,
 * odd character, indentation) becomes an `error` token instead of a throw, so
 * the parser reports it in order with the other errors of that line.
 */

import type { Span } from "./types";

export type TokenKind = "num" | "str" | "name" | "op" | "newline" | "eof" | "error";

export interface Token {
  kind: TokenKind;
  from: number;
  to: number;
  /** the source text */
  text: string;
  /** `num`: normalized digits; `str`: unescaped text; `error`: the message */
  value: string;
  /** `num` only: no dot and no exponent */
  int?: boolean;
}

export const KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
  "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

// longest first, so `**=` is not read as `**` then `=`
const OP = /\*\*=|\/\/=|<<=|>>=|\.\.\.|==|!=|<=|>=|\*\*|\/\/|:=|\+=|-=|\*=|\/=|%=|->|<>|<<|>>|&=|\|=|\^=|@=|[-+*/%()[\]{},.:;=<>!@~&|^]/y;
const D = String.raw`\d+(?:_\d+)*`;
const NUM = new RegExp(String.raw`(?:${D}(?:\.(?:${D})?)?|\.${D})(?:[eE][+-]?${D})?`, "y");
const NAME = /[\p{L}_][\p{L}\p{N}_]*/uy;
const WORD_REST = /[\p{L}\p{N}_]*/uy;
const STRING_PREFIX = /^(?:f|r|b|u|rb|br|fr|rf)$/i;
const ESCAPES: Record<string, string> = { "\\": "\\", "'": "'", '"': '"', n: "\n", t: "\t" };

const STRING_HELP = `strings are written '...' or "..." on one line`;

/** Offset to 1-based line and column. */
export function locator(source: string): (offset: number) => Span {
  const starts = [0];
  for (let i = source.indexOf("\n"); i >= 0; i = source.indexOf("\n", i + 1)) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { from: offset, to: offset, line: lo + 1, col: offset - starts[lo] + 1 };
  };
}

/** Always ends with a `newline` (unless the source is empty of statements) and an `eof`. */
export function lex(source: string): Token[] {
  const toks: Token[] = [];
  const n = source.length;
  const bom = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let i = bom;
  let depth = 0;

  const push = (kind: TokenKind, from: number, to: number, value = source.slice(from, to), int?: boolean) =>
    toks.push({ kind, from, to, text: source.slice(from, to), value, int });
  const err = (from: number, to: number, message: string) => push("error", from, to, message);
  const lastKind = () => toks[toks.length - 1]?.kind;
  // newlines inside brackets join the lines; blank and comment-only lines add none
  const newline = (from: number, to: number) => {
    if (depth === 0 && toks.length > 0 && lastKind() !== "newline") push("newline", from, to);
  };

  while (i < n) {
    const c = source[i];
    if (c === "\n") {
      newline(i, i + 1);
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }

    if (depth === 0 && (toks.length === 0 || lastKind() === "newline")) {
      const lineStart = Math.max(source.lastIndexOf("\n", i - 1) + 1, bom);
      if (i > lineStart) err(lineStart, i, "unexpected indentation: statements start at the beginning of the line");
    }

    if (c === "\\") {
      const eol = source.startsWith("\r\n", i + 1) ? 3 : source[i + 1] === "\n" ? 2 : 0;
      if (eol) {
        // the line break is swallowed so the next line is skipped with this one
        err(i, i + 1, "a backslash line continuation is not allowed: put the expression inside ( ) to continue it on the next line");
        i += eol;
      } else {
        err(i, i + 1, "unexpected character `\\`");
        i++;
      }
      continue;
    }

    if (c === '"' || c === "'") {
      const triple = c.repeat(3);
      if (source.startsWith(triple, i)) {
        const close = source.indexOf(triple, i + 3);
        const end = close < 0 ? n : close + 3;
        err(i, end, `triple-quoted strings are not allowed: ${STRING_HELP}`);
        i = end;
        continue;
      }
      let j = i + 1;
      let value = "";
      let bad = "";
      let closed = false;
      while (j < n && source[j] !== "\n") {
        const ch = source[j];
        if (ch === c) {
          closed = true;
          j++;
          break;
        }
        if (ch === "\\" && j + 1 < n && source[j + 1] !== "\n") {
          const mapped = ESCAPES[source[j + 1]];
          if (mapped === undefined) bad ||= `unsupported escape \`\\${source[j + 1]}\` in a string: the escapes are \\\\ \\' \\" \\n \\t`;
          else value += mapped;
          j += 2;
          continue;
        }
        value += ch;
        j++;
      }
      if (!closed) err(i, j, `this string is not closed: ${STRING_HELP}`);
      else if (bad) err(i, j, bad);
      else push("str", i, j, value);
      i = j;
      continue;
    }

    NUM.lastIndex = i;
    const num = NUM.exec(source);
    if (num) {
      let end = i + num[0].length;
      WORD_REST.lastIndex = end;
      const rest = WORD_REST.exec(source)![0];
      end += rest.length;
      if (rest) {
        err(i, end, `\`${source.slice(i, end)}\` is not a valid number: write digits like 1_000 or 1.5`);
      } else {
        const raw = num[0];
        const value = raw.replaceAll("_", "").replace(/^\./, "0.").replace(/\.(?=$|[eE])/, ".0");
        push("num", i, end, value, !/[.eE]/.test(raw));
      }
      i = end;
      continue;
    }

    NAME.lastIndex = i;
    const name = NAME.exec(source);
    if (name) {
      const end = i + name[0].length;
      if ((source[end] === '"' || source[end] === "'") && STRING_PREFIX.test(name[0])) {
        const what = /f/i.test(name[0]) ? "f-strings" : "string prefixes";
        err(i, end, `${what} are not allowed: ${STRING_HELP}`);
      } else {
        push("name", i, end);
      }
      i = end;
      continue;
    }

    OP.lastIndex = i;
    const op = OP.exec(source);
    if (op) {
      if ("([{".includes(op[0])) depth++;
      else if (")]}".includes(op[0])) depth = Math.max(0, depth - 1);
      push("op", i, i + op[0].length);
      i += op[0].length;
      continue;
    }

    const len = String.fromCodePoint(source.codePointAt(i)!).length;
    err(i, i + len, `unexpected character \`${source.slice(i, i + len)}\``);
    i += len;
  }

  newline(n, n);
  push("eof", n, n);
  return toks;
}
