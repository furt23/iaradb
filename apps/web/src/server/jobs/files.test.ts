import { describe, expect, it } from "vitest";

import { jobToml, parseJob, taskOf, type JobSpec } from "@/lib/jobs";

import { retargetTargets, retargetToml } from "./files";

const SPEC: JobSpec = {
  id: "nightly",
  name: "Nightly",
  tasks: [taskOf("notebooks/sales.py")],
  params: {},
  notify: [],
  schedule: "0 6 * * *",
  cluster: "job",
  instanceType: null,
  timeoutMinutes: 30,
  enabled: true,
};

describe("retargetToml", () => {
  it("gives the same file as writing the job again with the new target", () => {
    const moved = retargetToml(jobToml(SPEC), "notebooks/sales.py", "archive/sales.py");
    expect(moved).toBe(jobToml({ ...SPEC, tasks: [taskOf("archive/sales.py")] }));
    expect(parseJob("nightly", moved).tasks[0].target).toBe("archive/sales.py");
  });

  it("keeps hand-written comments and keys", () => {
    const toml = '# my note\nname = "N"\ntarget = \'notebooks/sales.py\'  # the report\nschedule = "0 6 * * *"\nowner = "me"\n';
    expect(retargetToml(toml, "notebooks/sales.py", "n/s.py")).toBe('# my note\nname = "N"\ntarget = "n/s.py"  # the report\nschedule = "0 6 * * *"\nowner = "me"\n');
  });

  it("keeps Windows line endings", () => {
    const toml = jobToml(SPEC).replaceAll("\n", "\r\n");
    const moved = retargetToml(toml, "notebooks/sales.py", "x.py");
    expect(moved).toBe(jobToml({ ...SPEC, tasks: [taskOf("x.py")] }).replaceAll("\n", "\r\n"));
  });

  it("only changes the target line", () => {
    const toml = 'name = "target = notebooks/sales.py"\ntarget = "notebooks/sales.py"\n';
    expect(retargetToml(toml, "notebooks/sales.py", "b.py")).toBe('name = "target = notebooks/sales.py"\ntarget = "b.py"\n');
  });
});

describe("retargetToml with several tasks", () => {
  const TASKS = [
    "# A Iara job: 2 tasks by hand.",
    'name = "Two"',
    'timeout_minutes = 60',
    "",
    "[[task]]",
    'key = "load"',
    'target = "notebooks/load.py"',
    "",
    "[[task]]",
    'key = "report"',
    "target = 'notebooks/report.sql'  # the report",
    'depends_on = ["load"]',
    "",
    "[task.params]",
    'target = "notebooks/load.py"',
    "",
  ].join("\n");

  it("moves every task target, and only those", () => {
    const moves = new Map([
      ["notebooks/load.py", "etl/load.py"],
      ["notebooks/report.sql", "etl/report.sql"],
    ]);
    expect(retargetTargets(TASKS, moves)).toBe(
      [
        "# A Iara job: 2 tasks by hand.",
        'name = "Two"',
        "timeout_minutes = 60",
        "",
        "[[task]]",
        'key = "load"',
        'target = "etl/load.py"',
        "",
        "[[task]]",
        'key = "report"',
        'target = "etl/report.sql"  # the report',
        'depends_on = ["load"]',
        "",
        "[task.params]",
        // the same key in a params table is a parameter, not a target
        'target = "notebooks/load.py"',
        "",
      ].join("\n"),
    );
  });

  it("follows a move of a folder through each task", () => {
    const moves = new Map([
      ["notebooks/load.py", "old/load.py"],
      ["notebooks/report.sql", "old/report.sql"],
    ]);
    const moved = retargetTargets(TASKS, moves);
    expect(parseJob("two", moved).tasks.map((t) => t.target)).toEqual(["old/load.py", "old/report.sql"]);
    expect(parseJob("two", moved).tasks[1].dependsOn).toEqual(["load"]);
  });

  it("leaves a params table's target key alone", () => {
    const toml = '[params]\ntarget = "notebooks/sales.py"\n\n[[task]]\ntarget = "notebooks/sales.py"\n';
    expect(retargetToml(toml, "notebooks/sales.py", "b.py")).toBe('[params]\ntarget = "notebooks/sales.py"\n\n[[task]]\ntarget = "b.py"\n');
  });

  it("moves the target of a one-task job written with a [[task]] table", () => {
    const toml = '# A Iara job: runs notebooks/a.py by hand.\n[[task]]\ntarget = "notebooks/a.py"\n';
    expect(retargetToml(toml, "notebooks/a.py", "b/a.py")).toBe('# A Iara job: runs b/a.py by hand.\n[[task]]\ntarget = "b/a.py"\n');
  });

  it("does not touch the header of a different target that shares its start", () => {
    const toml = '# A Iara job: runs notebooks/a.py.bak by hand.\ntarget = "notebooks/a.py.bak"\n';
    expect(retargetToml(toml, "notebooks/a.py", "b.py")).toBe(toml);
  });
});
