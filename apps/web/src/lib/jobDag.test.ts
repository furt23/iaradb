import { describe, expect, it } from "vitest";

import { readyTasks, runIfSatisfied, skipStatus, topoOrder, validateDag } from "./jobDag";
import { RUN_IFS, taskOf, type RunIf, type TaskRunStatus, type TaskSpec } from "./jobs";

const t = (key: string, dependsOn: string[] = [], runIf: RunIf = "all_success"): TaskSpec => ({ ...taskOf(`${key}.py`, key), dependsOn, runIf });

describe("validateDag", () => {
  it("accepts a DAG", () => {
    expect(validateDag([t("a"), t("b", ["a"]), t("c", ["a", "b"])])).toEqual([]);
    expect(validateDag([])).toEqual([]);
  });

  it("names what is wrong", () => {
    expect(validateDag([t("")])).toEqual(["a task has an empty key"]);
    expect(validateDag([t("bad key")])).toEqual(['task key "bad key" has characters other than letters, digits, _ and -']);
    expect(validateDag([t("a"), t("a")])).toEqual(['task key "a" is used twice']);
    expect(validateDag([t("a", ["zz"])])).toEqual(['task "a" depends on "zz", which is not a task']);
    expect(validateDag([t("a", ["a"])])).toEqual(['task "a" depends on itself']);
    expect(validateDag([t("a"), t("b", ["a", "a"])])).toEqual(['task "b" lists "a" twice']);
  });

  it("names the tasks of a cycle", () => {
    expect(validateDag([t("a", ["b"]), t("b", ["a"])])).toEqual(["dependency cycle: a -> b -> a"]);
    // a task downstream of the cycle is not named as part of it
    expect(validateDag([t("x", ["a"]), t("a", ["b"]), t("b", ["c"]), t("c", ["a"])])).toEqual(["dependency cycle: a -> b -> c -> a"]);
  });
});

describe("topoOrder", () => {
  it("puts every task after its upstream tasks", () => {
    expect(topoOrder([t("a"), t("b", ["a"]), t("c", ["a"]), t("d", ["b", "c"])])).toEqual(["a", "b", "c", "d"]);
  });

  it("is deterministic in declaration order", () => {
    expect(topoOrder([t("d", ["b", "c"]), t("c", ["a"]), t("b", ["a"]), t("a")])).toEqual(["a", "c", "b", "d"]);
  });

  it("leaves out tasks in a cycle", () => {
    expect(topoOrder([t("a", ["b"]), t("b", ["a"]), t("c")])).toEqual(["c"]);
  });
});

describe("runIfSatisfied", () => {
  const cases: [RunIf, TaskRunStatus[], boolean][] = [
    ["all_success", ["succeeded", "succeeded"], true],
    ["all_success", ["succeeded", "skipped"], false],
    ["all_success", ["succeeded", "failed"], false],
    ["all_done", ["succeeded", "failed", "skipped", "upstream_failed", "cancelled"], true],
    ["all_done", ["succeeded", "running"], false],
    ["at_least_one_success", ["failed", "succeeded"], true],
    ["at_least_one_success", ["failed", "skipped"], false],
    ["none_failed", ["succeeded", "skipped"], true],
    ["none_failed", ["succeeded", "upstream_failed"], false],
    ["none_failed", ["failed"], false],
    ["all_failed", ["failed", "upstream_failed"], true],
    ["all_failed", ["failed", "succeeded"], false],
  ];
  it.each(cases)("%s on %j is %s", (runIf, upstreams, ok) => {
    expect(runIfSatisfied(runIf, upstreams)).toBe(ok);
  });

  it("runs a task without upstream tasks, whatever its run_if", () => {
    for (const runIf of RUN_IFS) expect(runIfSatisfied(runIf, [])).toBe(true);
  });
});

describe("readyTasks", () => {
  const tasks = [t("ingest"), t("report", ["ingest"]), t("notify", ["ingest", "report"], "all_done")];

  it("starts the tasks without upstream tasks", () => {
    expect(readyTasks(tasks, {})).toEqual(["ingest"]);
  });

  it("starts a task once its upstream tasks succeeded", () => {
    expect(readyTasks(tasks, { ingest: "succeeded" })).toEqual(["report"]);
    expect(readyTasks(tasks, { ingest: "succeeded", report: "running" })).toEqual([]);
  });

  it("waits while an upstream task is still going", () => {
    expect(readyTasks(tasks, { ingest: "running" })).toEqual([]);
  });

  it("starts a task whose run_if holds after a failure", () => {
    expect(readyTasks(tasks, { ingest: "failed" })).toEqual([]);
    expect(readyTasks(tasks, { ingest: "failed", report: "upstream_failed" })).toEqual(["notify"]);
  });

  it("only starts pending tasks", () => {
    expect(readyTasks(tasks, { ingest: "succeeded", report: "succeeded" })).toEqual(["notify"]);
    expect(readyTasks(tasks, { ingest: "succeeded", report: "skipped" })).toEqual(["notify"]);
  });

  it("treats a task with no state as pending, even for keys that are object properties", () => {
    expect(readyTasks([t("constructor")], {})).toEqual(["constructor"]);
  });

  it("never starts a task of a cycle", () => {
    expect(readyTasks([t("a", ["b"]), t("b", ["a"])], {})).toEqual([]);
  });
});

describe("skipStatus", () => {
  const report = t("report", ["ingest"]);

  it("is upstream_failed when an upstream failed and run_if does not hold", () => {
    expect(skipStatus(report, { ingest: "failed" })).toBe("upstream_failed");
    expect(skipStatus(report, { ingest: "upstream_failed" })).toBe("upstream_failed");
    expect(skipStatus(t("x", ["ingest"], "none_failed"), { ingest: "cancelled" })).toBe("upstream_failed");
  });

  it("is skipped when no upstream failed and run_if does not hold", () => {
    expect(skipStatus(report, { ingest: "skipped" })).toBe("skipped");
    expect(skipStatus(t("x", ["ingest"], "all_failed"), { ingest: "succeeded" })).toBe("skipped");
  });

  it("is null while the task can run or still waits", () => {
    expect(skipStatus(report, { ingest: "succeeded" })).toBeNull();
    expect(skipStatus(report, { ingest: "running" })).toBeNull();
    expect(skipStatus(report, {})).toBeNull();
    expect(skipStatus(t("x", ["ingest"], "none_failed"), { ingest: "skipped" })).toBeNull();
  });

  it("is null for a task that is no longer pending", () => {
    expect(skipStatus(report, { ingest: "failed", report: "running" })).toBeNull();
  });
});
