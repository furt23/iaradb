/** What the Ask dialog and the Ask actions exchange (pure types). */

import type { ChartWidget, TableWidget, WidgetData } from "./types";

/** One thing Ask did on the way, for the dialog's progress list. */
export interface AskStep {
  step: "link" | "describe" | "synthesize" | "validate";
  /** English text: the tables picked, or why an attempt was refused */
  note: string;
}

/** A dataset and a widget Ask proposes; nothing is saved until the user approves. */
export interface AskProposal {
  dataset: { name: string; sql: string };
  /** `dataset` is the proposed dataset's name, `id` is free in the dashboard */
  widget: ChartWidget | TableWidget;
  explanation: string;
  /** the tables picked for the question (full names) */
  tables: string[];
  /** the widget's data, from the unsaved dataset (an `error` when it did not run) */
  preview: WidgetData;
  steps: AskStep[];
}

export type AskDecision = { kind: "approve" } | { kind: "change"; feedback: string } | { kind: "cancel" };

/** Where an Ask stands: waiting for the user's decision (`thread` answers it), or over with a message. */
export type AskReply = { thread: string; proposal: AskProposal } | { message: string };

/** After a decision: saved, or still `AskReply` (a change asks for a new proposal). */
export type AskAnswer = AskReply | { saved: { dataset: string; widget: string } };

export const MAX_QUESTION = 2000;
