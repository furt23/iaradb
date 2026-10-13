/**
 * The job form's drafts and their conversion to and from a job's tasks, params
 * and notifications (pure). Fields are text while they are edited; a task draft
 * names its upstream tasks by `id`, so renaming a key keeps the arrows.
 */

import { validateDag } from "@/lib/jobDag";
import { NOTIFY_EVENTS, RUN_IF_DEFAULT, type NotifyEvent, type NotifySpec, type ParamValue, type Params, type RunIf, type TaskSpec } from "@/lib/jobs";

export interface ParamRow {
  key: string;
  value: string;
}

/** The rows of a params table, in its order. */
export function paramsToRows(params: Params): ParamRow[] {
  return Object.entries(params).map(([key, value]) => ({ key, value: String(value) }));
}

/** A typed value from its text: `true`/`false` and numbers keep their type, anything else is text. */
export function paramValue(text: string): ParamValue {
  if (text === "true") return true;
  if (text === "false") return false;
  // "007" and "1e3" stay text: only a number that reads back as written is one
  if (text !== "" && Number.isFinite(Number(text)) && String(Number(text)) === text) return Number(text);
  return text;
}

const PARAM_KEY = /^[\w.-]+$/;

/** The params of some rows (blank rows are left out) and what is wrong with them. */
export function rowsToParams(rows: ParamRow[]): { params: Params; errors: string[] } {
  const params: Params = {};
  const errors: string[] = [];
  for (const row of rows) {
    const key = row.key.trim();
    if (!key && !row.value.trim()) continue;
    if (!key) errors.push("a param has a value but no name");
    else if (!PARAM_KEY.test(key)) errors.push(`param "${key}" has characters other than letters, digits, _, . and -`);
    else if (Object.hasOwn(params, key)) errors.push(`param "${key}" is used twice`);
    else params[key] = paramValue(row.value);
  }
  return { params, errors };
}

/** The params of a run to start: what the edited params add to or change in the job's. */
export function paramOverrides(base: Params, edited: Params): Params {
  return Object.fromEntries(Object.entries(edited).filter(([k, v]) => !Object.hasOwn(base, k) || base[k] !== v));
}

export interface TaskDraft {
  id: string;
  key: string;
  target: string;
  /** the `id`s of the upstream tasks */
  dependsOn: string[];
  runIf: RunIf;
  maxRetries: string;
  retryBackoffSeconds: string;
  /** empty: the job's timeout */
  timeoutMinutes: string;
  params: ParamRow[];
}

let counter = 0;
export function newDraftId(): string {
  counter += 1;
  return `t${counter}`;
}

/** The drafts of a job's tasks. */
export function draftsOf(tasks: TaskSpec[]): TaskDraft[] {
  const ids = new Map(tasks.map((t) => [t.key, newDraftId()]));
  return tasks.map((t) => ({
    id: ids.get(t.key)!,
    key: t.key,
    target: t.target,
    dependsOn: t.dependsOn.flatMap((k) => (ids.has(k) ? [ids.get(k)!] : [])),
    runIf: t.runIf,
    maxRetries: String(t.maxRetries),
    retryBackoffSeconds: String(t.retryBackoffSeconds),
    timeoutMinutes: t.timeoutMinutes === undefined ? "" : String(t.timeoutMinutes),
    params: paramsToRows(t.params),
  }));
}

/** A new task after `drafts`: a free key, and it runs after the last task. */
export function blankDraft(drafts: TaskDraft[], target = ""): TaskDraft {
  const keys = new Set(drafts.map((d) => d.key));
  let n = drafts.length + 1;
  while (keys.has(`task_${n}`)) n += 1;
  return {
    id: newDraftId(),
    key: `task_${n}`,
    target,
    dependsOn: drafts.length ? [drafts[drafts.length - 1].id] : [],
    runIf: RUN_IF_DEFAULT,
    maxRetries: "0",
    retryBackoffSeconds: "0",
    timeoutMinutes: "",
    params: [],
  };
}

/** The drafts without one task (the others stop depending on it). */
export function removeDraft(drafts: TaskDraft[], id: string): TaskDraft[] {
  return drafts.filter((d) => d.id !== id).map((d) => ({ ...d, dependsOn: d.dependsOn.filter((x) => x !== id) }));
}

export interface TaskFieldErrors {
  target?: string;
  maxRetries?: string;
  retryBackoffSeconds?: string;
  timeoutMinutes?: string;
  params: string[];
}

function whole(text: string, min: number, max: number): number | null {
  if (text.trim() === "") return min;
  const n = Number(text);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** What is wrong with the fields of one task (the same limits as a saved job's). */
export function fieldErrors(d: TaskDraft): TaskFieldErrors {
  const errors: TaskFieldErrors = { params: rowsToParams(d.params).errors };
  if (!d.target) errors.target = "Pick what the task runs";
  if (whole(d.maxRetries, 0, 10) === null) errors.maxRetries = "A whole number from 0 to 10";
  if (whole(d.retryBackoffSeconds, 0, 3600) === null) errors.retryBackoffSeconds = "A whole number from 0 to 3600";
  if (d.timeoutMinutes.trim() !== "" && whole(d.timeoutMinutes, 1, 24 * 60) === null) errors.timeoutMinutes = "A whole number from 1 to 1440";
  return errors;
}

function hasErrors(e: TaskFieldErrors): boolean {
  return Boolean(e.target || e.maxRetries || e.retryBackoffSeconds || e.timeoutMinutes || e.params.length);
}

export interface TasksCheck {
  /** the tasks as far as the drafts allow (for the picture); valid when there are no errors */
  tasks: TaskSpec[];
  /** the graph's problems: keys, unknown upstream tasks, cycles */
  dagErrors: string[];
  fields: Record<string, TaskFieldErrors>;
  valid: boolean;
}

/** The tasks of some drafts, with everything wrong with them. */
export function checkDrafts(drafts: TaskDraft[]): TasksCheck {
  const keyOf = new Map(drafts.map((d) => [d.id, d.key.trim()]));
  const fields: Record<string, TaskFieldErrors> = {};
  const tasks: TaskSpec[] = drafts.map((d) => {
    fields[d.id] = fieldErrors(d);
    return {
      key: d.key.trim(),
      target: d.target,
      dependsOn: d.dependsOn.flatMap((id) => (keyOf.has(id) ? [keyOf.get(id)!] : [])),
      runIf: d.runIf,
      maxRetries: whole(d.maxRetries, 0, 10) ?? 0,
      retryBackoffSeconds: whole(d.retryBackoffSeconds, 0, 3600) ?? 0,
      timeoutMinutes: d.timeoutMinutes.trim() === "" ? undefined : (whole(d.timeoutMinutes, 1, 24 * 60) ?? undefined),
      params: rowsToParams(d.params).params,
    };
  });
  const dagErrors = tasks.length ? validateDag(tasks) : ["a job has at least one task"];
  return { tasks, dagErrors, fields, valid: !dagErrors.length && !Object.values(fields).some(hasErrors) };
}

export interface NotifyDraft {
  webhook: string;
  on: NotifyEvent[];
}

export function notifyDrafts(notify: NotifySpec[]): NotifyDraft[] {
  return notify.map((n) => ({ webhook: n.webhook, on: [...n.on] }));
}

export function blankNotify(): NotifyDraft {
  return { webhook: "", on: ["failure"] };
}

/** What is wrong with one webhook (null when nothing). */
export function notifyError(n: NotifyDraft): string | null {
  const url = n.webhook.trim();
  if (!url) return "A webhook URL is missing";
  if (!/^https?:\/\//.test(url)) return "An http or https URL";
  if (!n.on.length) return "Pick at least one event";
  return null;
}

export function notifyOf(drafts: NotifyDraft[]): NotifySpec[] {
  return drafts.map((n) => ({ webhook: n.webhook.trim(), on: NOTIFY_EVENTS.filter((e) => n.on.includes(e)) }));
}
