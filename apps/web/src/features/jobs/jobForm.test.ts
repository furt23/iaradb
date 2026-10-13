import { describe, expect, it } from "vitest";

import { taskOf } from "@/lib/jobs";

import {
  blankDraft,
  checkDrafts,
  draftsOf,
  notifyError,
  notifyOf,
  paramOverrides,
  paramValue,
  paramsToRows,
  removeDraft,
  rowsToParams,
} from "./jobForm";
import { firstTask, statusTone } from "./taskStatus";

describe("params rows", () => {
  it("round-trips a params table", () => {
    const params = { day: "2026-01-01", n: 5, full: true, ratio: 0.5 };
    const back = rowsToParams(paramsToRows(params));
    expect(back.errors).toEqual([]);
    expect(back.params).toEqual(params);
  });

  it("types values only when they read back as written", () => {
    expect(paramValue("12")).toBe(12);
    expect(paramValue("true")).toBe(true);
    expect(paramValue("007")).toBe("007");
    expect(paramValue("1e3")).toBe("1e3");
    expect(paramValue("")).toBe("");
    expect(paramValue("abc")).toBe("abc");
  });

  it("skips blank rows and reports bad ones", () => {
    const { params, errors } = rowsToParams([
      { key: "", value: "" },
      { key: "a", value: "1" },
      { key: "a", value: "2" },
      { key: "", value: "x" },
      { key: "b c", value: "x" },
    ]);
    expect(params).toEqual({ a: 1 });
    expect(errors).toEqual(['param "a" is used twice', "a param has a value but no name", expect.stringContaining('param "b c"')]);
  });

  it("keeps only the params a run changes or adds", () => {
    expect(paramOverrides({ a: 1, b: "x" }, { a: 1, b: "y", c: true })).toEqual({ b: "y", c: true });
    expect(paramOverrides({}, {})).toEqual({});
  });
});

describe("task drafts", () => {
  const spec = [
    { ...taskOf("a.py", "extract") },
    { ...taskOf("b.sql", "load"), dependsOn: ["extract"], runIf: "all_done" as const, maxRetries: 2, retryBackoffSeconds: 30, timeoutMinutes: 15, params: { day: "x" } },
  ];

  it("turns tasks into drafts and back", () => {
    const check = checkDrafts(draftsOf(spec));
    expect(check.valid).toBe(true);
    expect(check.tasks).toEqual(spec);
  });

  it("names a new task freely and runs it after the last", () => {
    const drafts = draftsOf(spec);
    const t = blankDraft(drafts);
    expect(t.key).toBe("task_3");
    expect(t.dependsOn).toEqual([drafts[1].id]);
    expect(blankDraft([]).dependsOn).toEqual([]);
    const taken = blankDraft([{ ...drafts[0], key: "task_2" }, drafts[1]]);
    expect(taken.key).toBe("task_3");
  });

  it("keeps the arrows when a key changes, and drops them when a task goes", () => {
    const drafts = draftsOf(spec);
    const renamedFirst = [{ ...drafts[0], key: "pull" }, drafts[1]];
    expect(checkDrafts(renamedFirst).tasks[1].dependsOn).toEqual(["pull"]);
    const removed = removeDraft(drafts, drafts[0].id);
    expect(removed).toHaveLength(1);
    expect(removed[0].dependsOn).toEqual([]);
  });

  it("reports the graph's problems", () => {
    const [a, b] = draftsOf(spec);
    const cyclic = checkDrafts([{ ...a, dependsOn: [b.id] }, b]);
    expect(cyclic.valid).toBe(false);
    expect(cyclic.dagErrors.join()).toContain("dependency cycle");
    const twice = checkDrafts([a, { ...b, key: "extract" }]);
    expect(twice.dagErrors.join()).toContain("used twice");
    expect(checkDrafts([{ ...a, key: "bad key" }]).dagErrors.join()).toContain("characters other than");
    expect(checkDrafts([]).valid).toBe(false);
  });

  it("reports field errors against a task", () => {
    const [a] = draftsOf(spec);
    const check = checkDrafts([{ ...a, target: "", maxRetries: "11", retryBackoffSeconds: "1.5", timeoutMinutes: "0", params: [{ key: "", value: "v" }] }]);
    expect(check.valid).toBe(false);
    expect(check.fields[a.id]).toMatchObject({
      target: expect.any(String),
      maxRetries: expect.any(String),
      retryBackoffSeconds: expect.any(String),
      timeoutMinutes: expect.any(String),
    });
    expect(check.fields[a.id].params).toHaveLength(1);
    // an empty timeout is the job's
    expect(checkDrafts([{ ...a, timeoutMinutes: "" }]).tasks[0].timeoutMinutes).toBeUndefined();
  });
});

describe("notifications", () => {
  it("checks a webhook", () => {
    expect(notifyError({ webhook: "", on: ["failure"] })).toMatch(/missing/);
    expect(notifyError({ webhook: "ftp://x", on: ["failure"] })).toMatch(/http/);
    expect(notifyError({ webhook: "https://x.test/h", on: [] })).toMatch(/event/);
    expect(notifyError({ webhook: "https://x.test/h", on: ["start"] })).toBeNull();
  });

  it("writes the events in their order", () => {
    expect(notifyOf([{ webhook: " https://x.test/h ", on: ["failure", "start"] }])).toEqual([{ webhook: "https://x.test/h", on: ["start", "failure"] }]);
  });
});

describe("task status", () => {
  it("reads a status as a tone", () => {
    expect(statusTone("succeeded")).toBe("success");
    expect(statusTone("upstream_failed")).toBe("error");
    expect(statusTone("running")).toBe("info");
    expect(statusTone("skipped")).toBe("muted");
  });

  it("shows a failed task first, then a running one", () => {
    const t = (key: string, status: "succeeded" | "failed" | "running" | "pending") => ({ key, status, attempt: 1 });
    expect(firstTask([t("a", "succeeded"), t("b", "running"), t("c", "failed")])).toBe("c");
    expect(firstTask([t("a", "succeeded"), t("b", "running")])).toBe("b");
    expect(firstTask([t("a", "pending")])).toBe("a");
    expect(firstTask([])).toBeNull();
  });
});
