/**
 * The outline of a notebook: the headings of its markdown cells, as a tree (pure).
 *
 * Headings are found the way the Markdown renderer finds them (ATX and setext,
 * also inside quotes and list items), so `index` matches the `data-heading-index`
 * tagged on the rendered heading.
 */

import type { Cell } from "@workhouse/protocol";

/** A heading of a markdown text. */
export interface MarkdownHeading {
  /** 0-based, among all the headings of the text */
  index: number;
  /** 1-based line where the heading starts */
  line: number;
  /** the number of #, or the depth of the section number */
  level: number;
  /** the normalized section number ("2.1") when the heading starts with one */
  number: string | null;
  /** the heading text, without its section number and inline markers */
  text: string;
}

export interface OutlineNode {
  cellId: string;
  /** heading index within its cell */
  index: number;
  text: string;
  level: number;
  number: string | null;
  children: OutlineNode[];
}

/** A heading as the scan finds it, before its text is cleaned. */
interface RawHeading {
  line: number;
  level: number;
  text: string;
}

interface Fence {
  char: string;
  length: number;
}

/** The paragraph line(s) a setext underline would turn into a heading. */
interface Paragraph {
  line: number;
  parts: string[];
}

interface Scan {
  fence: Fence | null;
  paragraph: Paragraph | null;
  found: RawHeading[];
}

/** Blockquote and list markers in front of a line (a heading may sit behind them). */
const CONTAINER = /^(?:[ \t]{0,3}(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+))+/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const ATX = /^ {0,3}(#{1,6})(?=[ \t]|$)(.*)$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
/** "1", "1.", "1)", "1.1", "2.1.3" ... followed by the heading text (up to 3 digits a part, so "2024 Results" is not a section). */
const SECTION_NUMBER = /^(\d{1,3}(?:\.\d{1,3})*)[.)]?[ \t]+(\S.*)$/;

/** The headings of a markdown text, in order. Empty headings are kept (they still count in the rendering). */
export function markdownHeadings(text: string): MarkdownHeading[] {
  return scanHeadings(text).map((raw, index) => toHeading(raw, index));
}

/** The outline of the markdown cells, nested by heading level (other cells are ignored). */
export function outlineOf(cells: Cell[]): OutlineNode[] {
  const flat = cells
    .filter((c) => c.kind === "markdown")
    .flatMap((c) =>
      markdownHeadings(c.code)
        .filter((h) => h.text)
        .map((h) => ({ cellId: c.id, index: h.index, text: h.text, level: h.level, number: h.number })),
    );
  return nest(flat);
}

function scanHeadings(text: string): RawHeading[] {
  const scan: Scan = { fence: null, paragraph: null, found: [] };
  text.split(/\r?\n/).forEach((raw, i) => scanLine(scan, raw, i + 1));
  return scan.found;
}

function scanLine(s: Scan, raw: string, line: number): void {
  const body = raw.replace(CONTAINER, "");
  if (s.fence) {
    if (closesFence(body, s.fence)) s.fence = null;
    return;
  }
  const open = FENCE_OPEN.exec(body);
  if (open) {
    s.fence = { char: open[1][0], length: open[1].length };
    s.paragraph = null;
    return;
  }
  const atx = ATX.exec(body);
  if (atx) {
    s.found.push({ line, level: atx[1].length, text: atxText(atx[2]) });
    s.paragraph = null;
    return;
  }
  if (s.paragraph && SETEXT.test(raw)) {
    s.found.push({ line: s.paragraph.line, level: raw.trim().startsWith("=") ? 1 : 2, text: s.paragraph.parts.join(" ") });
    s.paragraph = null;
    return;
  }
  s.paragraph = isParagraphLine(raw) ? { line: s.paragraph?.line ?? line, parts: [...(s.paragraph?.parts ?? []), raw.trim()] } : null;
}

function closesFence(body: string, fence: Fence): boolean {
  const m = FENCE_CLOSE.exec(body);
  return !!m && m[1][0] === fence.char && m[1].length >= fence.length;
}

/** A plain text line: it can start or continue a paragraph (not a list item, quote or indented code). */
function isParagraphLine(raw: string): boolean {
  return /^ {0,3}\S/.test(raw) && !CONTAINER.test(raw);
}

/** The text of an ATX heading without its optional closing sequence ("## Title ##"). */
function atxText(rest: string): string {
  return rest.trim().replace(/(^|[ \t]+)#+$/, "");
}

function toHeading(raw: RawHeading, index: number): MarkdownHeading {
  const text = cleanInline(raw.text);
  const section = SECTION_NUMBER.exec(text);
  if (!section) return { index, line: raw.line, level: raw.level, number: null, text };
  const number = section[1]
    .split(".")
    .map((part) => String(Number(part)))
    .join(".");
  // a section number sets the level: 1 is top level, 2.1 is a child of 2
  return { index, line: raw.line, level: number.split(".").length, number, text: section[2] };
}

/** Plain text of a heading: links, code spans, emphasis and escapes resolved. */
function cleanInline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*{1,3}|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|\W)_{1,3}(?=\S)(.+?)(?<=\S)_{1,3}(?!\w)/g, "$1$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

interface FlatHeading {
  cellId: string;
  index: number;
  text: string;
  level: number;
  number: string | null;
}

/** Nests the headings in order: a heading is a child of the nearest shallower one before it. */
function nest(flat: FlatHeading[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  // the chain from the top level to the last heading
  const chain: OutlineNode[] = [];
  for (const h of flat) {
    const node: OutlineNode = { ...h, children: [] };
    while (chain.length && chain[chain.length - 1].level >= node.level) chain.pop();
    const parent = chain[chain.length - 1];
    (parent ? parent.children : roots).push(node);
    chain.push(node);
  }
  return roots;
}
