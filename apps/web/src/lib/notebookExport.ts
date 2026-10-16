/**
 * Notebook exports (pure): a Jupyter notebook (nbformat 4.5) and a Markdown
 * document, built from the cells as the editor holds them (unsaved edits too).
 */

import type { Cell } from "@iara/protocol";

import { baseName } from "./paths";

/** nbformat keeps a cell's text as lines, each with its newline. */
function lines(text: string): string[] {
  return text.split(/(?<=\n)/).filter((line) => line !== "");
}

/** nbformat cell ids: letters, digits, `-` and `_`, at most 64 characters. */
function cellId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) || "cell";
}

function codeCell(id: string, metadata: Record<string, unknown>, source: string[]): Record<string, unknown> {
  return { cell_type: "code", id, execution_count: null, metadata, outputs: [], source };
}

function ipynbCell(cell: Cell): Record<string, unknown> {
  const id = cellId(cell.id);
  if (cell.kind === "markdown") return { cell_type: "markdown", id, metadata: {}, source: lines(cell.code) };
  // SQL cells run through the %%sql magic of Jupyter's SQL kernels
  if (cell.kind === "sql") return codeCell(id, { iara: { kind: "sql" } }, lines(`%%sql\n${cell.code}`));
  return codeCell(id, {}, lines(cell.code));
}

/** The notebook as a Jupyter file (without outputs: they are not kept in the editor). */
export function toIpynb(cells: Cell[], { name }: { name: string }): string {
  const notebook = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: "python3", display_name: "Python 3", language: "python" },
      language_info: { name: "python" },
      iara: { name },
    },
    cells: cells.map(ipynbCell),
  };
  return `${JSON.stringify(notebook, null, 1)}\n`;
}

/** A code block whose fence is longer than any backtick run in the code, so the code cannot close it. */
function fence(code: string, lang: string): string {
  const longest = (code.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 2);
  const marks = "`".repeat(longest + 1);
  return `${marks}${lang}\n${code}\n${marks}`;
}

/** The notebook as a Markdown document: markdown cells as they are, code in fences, empty cells left out. */
export function toMarkdown(cells: Cell[], { title }: { title: string }): string {
  const blocks = [`# ${title}`];
  for (const cell of cells) {
    const text = cell.code.trimEnd();
    if (!text.trim()) continue;
    blocks.push(cell.kind === "markdown" ? text : fence(text, cell.kind === "sql" ? "sql" : "python"));
  }
  return `${blocks.join("\n\n")}\n`;
}

/** A file's name without its `.py` or `.sql` extension. */
export function fileStem(path: string): string {
  return baseName(path).replace(/\.(py|sql)$/i, "");
}

/** The name of an export of the file at `path`: its stem plus `ext`. */
export function exportName(path: string, ext: string): string {
  return `${fileStem(path)}${ext}`;
}
