import { applyEdits } from "@/lib/iara/edits";
import type { ContextCell, IaraAgent, IaraChange, IaraFileContext, IaraKnowledge, IaraProposalRecord, IaraStep, IaraToolUse } from "@/lib/iara/protocol";

/** A translation key and its values: the component runs it through `t`. */
export interface Label {
  key: string;
  values?: Record<string, string>;
}

export const AGENT_LABEL: Record<IaraAgent, string> = {
  iara: "Iara is thinking",
  analyst: "Looking at the data",
  author: "Writing the code",
  reviewer: "Reviewing the change",
  observer: "Reading the result",
};

/** The agents' names, shown over their steps in the timeline. */
export const AGENT_NAME: Record<IaraAgent, string> = {
  iara: "Iara",
  analyst: "Analyst",
  author: "Author",
  reviewer: "Reviewer",
  observer: "Observer",
};

/** What a data tool did, in the user's words (an unknown tool reads as looking at the data). */
export function toolLabel({ tool, target }: IaraToolUse): Label {
  switch (tool) {
    case "list_tables":
      return { key: "Listing tables" };
    case "describe_table":
      return target ? { key: "Reading {{target}}", values: { target } } : { key: "Reading a table" };
    case "explain_sql":
      return { key: "Checking the query" };
    case "run_sql":
      return { key: "Querying the data" };
    case "list_files":
      return { key: "Looking at the files" };
    case "read_file":
      return target ? { key: "Reading {{target}}", values: { target } } : { key: "Reading a file" };
    case "search_ontology":
      return target ? { key: "Looking up “{{target}}” in the ontology", values: { target } } : { key: "Reading the ontology" };
    default:
      return { key: "Looking at the data" };
  }
}

/** The ontology terms the steps of a message read, each once: by team, the certified ones before the drafts, then by name. */
export function knowledgeOf(steps: IaraStep[] | undefined): IaraKnowledge[] {
  const seen = new Map<string, IaraKnowledge>();
  for (const step of steps ?? []) {
    if (step.kind !== "tool") continue;
    for (const k of step.knowledge ?? []) seen.set(`${k.team}\n${k.term}`, k);
  }
  return [...seen.values()].sort((a, b) => a.team.localeCompare(b.team) || Number(b.certified) - Number(a.certified) || a.term.localeCompare(b.term));
}

/** A thought's heading (a leading `**line**`, without the asterisks) and the rest; a thought still streaming its heading has none. */
export function thoughtParts(text: string): { title: string | null; body: string } {
  const m = /^\s*\*\*([^*\n]+)\*\*[ \t]*(?:\n|$)([\s\S]*)$/.exec(text);
  if (!m) return { title: null, body: text.trim() };
  return { title: m[1].trim(), body: m[2].trim() };
}

export function changeTitle(change: IaraChange): Label {
  switch (change.action) {
    case "insert_cell":
      return { key: "New {{kind}} cell", values: { kind: change.kind } };
    case "edit_cell":
      return { key: "Edit cell" };
    case "run_cell":
      return { key: "Run cell" };
    case "edit_query":
      return { key: "Edit the query" };
  }
}

/**
 * The code a change starts from (null for a new cell) and the code it writes,
 * read from the file's context; null for a run. Throws when the edits no longer
 * fit the code (it changed since Iara read it).
 */
export function changeDiff(change: IaraChange, context: IaraFileContext): { before: string | null; after: string } | null {
  switch (change.action) {
    case "insert_cell":
      return { before: null, after: change.code };
    case "edit_cell": {
      const cell = context.surface === "notebook" ? context.cells.find((c) => c.id === change.cellId) : undefined;
      if (!cell) throw new Error("There is no cell with that id.");
      return { before: cell.code, after: applyEdits(cell.code, change.edits) };
    }
    case "edit_query":
      if (context.surface !== "sql") throw new Error("not possible in a notebook");
      return { before: context.query, after: applyEdits(context.query, change.edits) };
    case "run_cell":
      return null;
  }
}

/** The language of a change's code; an edit takes its cell's, read from the file's context (python when the cell is gone). */
export function changeLanguage(change: IaraChange, context?: IaraFileContext): ContextCell["kind"] {
  if (change.action === "insert_cell") return change.kind;
  if (change.action === "edit_cell" && context?.surface === "notebook") return context.cells.find((c) => c.id === change.cellId)?.kind ?? "python";
  return change.action === "edit_query" ? "sql" : "python";
}

/** What became of a decided proposal; `error` tones are shown in the error color. */
export function recordStatus(p: IaraProposalRecord): { label: Label; tone: "ok" | "error" | "muted" } {
  if (p.decision === "rejected") return { label: { key: "Rejected" }, tone: "muted" };
  const o = p.outcome;
  if (!o) return { label: { key: "Approved" }, tone: "muted" };
  const failed = o.status === "error";
  if (p.change.action === "run_cell") {
    if (!o.ran) return { label: { key: "Not run" }, tone: "error" };
    return failed ? { label: { key: "Ran with an error" }, tone: "error" } : { label: { key: "Ran" }, tone: "ok" };
  }
  if (!o.applied) return { label: { key: "Not applied" }, tone: "error" };
  if (!o.ran) return { label: { key: "Applied" }, tone: "ok" };
  return failed ? { label: { key: "Applied, ran with an error" }, tone: "error" } : { label: { key: "Applied and ran" }, tone: "ok" };
}
