import { describe, expect, it } from "vitest";

import { checkJob, due, jobId, jobToml, nextScheduled, parseJob, taskOf, type JobSpec } from "./jobs";

const spec: JobSpec = {
  id: "nightly_sales",
  name: "Nightly sales",
  tasks: [taskOf("notebooks/sales.py")],
  params: {},
  notify: [],
  schedule: "0 6 * * *",
  cluster: "job",
  instanceType: "m7i-flex.large",
  timeoutMinutes: 60,
  enabled: true,
};

/** the file of a job of several tasks, as written by hand */
const DAG_TOML = `name = "Nightly"
schedule = "0 6 * * *"
cluster = "job"
[params]
region = "EU"
[[task]]
key = "ingest"
target = "notebooks/ingest.py"
max_retries = 2
retry_backoff_seconds = 30
[[task]]
key = "report"
target = "queries/report.sql"
depends_on = ["ingest"]
run_if = "all_success"
[task.params]
limit = 100
[[notify]]
on = ["failure"]
webhook = "https://example.com/hook"
`;

describe("job files", () => {
  it("round-trip", () => {
    const text = jobToml(spec);
    expect(text.startsWith("# A Iara job: runs notebooks/sales.py on a schedule")).toBe(true);
    expect(parseJob("nightly_sales", text)).toEqual(spec);
  });

  it("keep the one-target form of a single task", () => {
    expect(jobToml(spec)).toBe(
      '# A Iara job: runs notebooks/sales.py on a schedule (cron, UTC).\nname = "Nightly sales"\ntarget = "notebooks/sales.py"\nschedule = "0 6 * * *"\ncluster = "job"\ninstance_type = "m7i-flex.large"\ntimeout_minutes = 60\n\n',
    );
  });

  it("fill in defaults", () => {
    expect(parseJob("q", 'target = "queries/refresh.sql"\n')).toEqual({
      id: "q",
      name: "q",
      tasks: [
        { key: "main", target: "queries/refresh.sql", dependsOn: [], runIf: "all_success", maxRetries: 0, retryBackoffSeconds: 0, params: {} },
      ],
      params: {},
      notify: [],
      schedule: null,
      cluster: "job",
      instanceType: null,
      timeoutMinutes: 60,
      enabled: true,
    });
  });

  it("read several tasks, params and notify", () => {
    const job = parseJob("nightly", DAG_TOML);
    expect(job.params).toEqual({ region: "EU" });
    expect(job.notify).toEqual([{ on: ["failure"], webhook: "https://example.com/hook" }]);
    expect(job.tasks).toEqual([
      { key: "ingest", target: "notebooks/ingest.py", dependsOn: [], runIf: "all_success", maxRetries: 2, retryBackoffSeconds: 30, params: {} },
      { key: "report", target: "queries/report.sql", dependsOn: ["ingest"], runIf: "all_success", maxRetries: 0, retryBackoffSeconds: 0, params: { limit: 100 } },
    ]);
  });

  it("write several tasks, params and notify, and read them back the same", () => {
    const job = parseJob("nightly", DAG_TOML);
    const text = jobToml(job);
    expect(text.startsWith("# A Iara job: runs 2 tasks on a schedule")).toBe(true);
    expect(text).toContain("[[task]]");
    // the target lines are in the tasks, not at the top of the file
    expect(text.split("[[")[0]).not.toContain("target =");
    expect(parseJob("nightly", text)).toEqual(job);
  });

  it("keep a single task of other settings in the several-task form", () => {
    const job: JobSpec = { ...spec, tasks: [{ ...taskOf("a.py", "load"), timeoutMinutes: 5, runIf: "all_done" }] };
    const text = jobToml(job);
    expect(text).toContain('key = "load"');
    expect(text).toContain("run_if = \"all_done\"");
    expect(parseJob("nightly_sales", text)).toEqual(job);
  });

  it("explain what is wrong", () => {
    expect(() => parseJob("x", "name = 'x'")).toThrow(/target is missing/);
    expect(() => parseJob("x", 'target = "data/x.csv"')).toThrow(/the target is a notebook \(\.py\) or a query file \(\.sql\)/);
    expect(() => parseJob("x", 'target = "a.py"\nschedule = "every day"')).toThrow(/schedule: a schedule has 5 fields/);
    expect(() => parseJob("x", "target = ")).toThrow(/not valid TOML/);
  });

  it("explain what is wrong with tasks", () => {
    expect(() => parseJob("x", 'target = "a.py"\n[[task]]\nkey = "a"\ntarget = "b.py"\n')).toThrow(/either a target or \[\[task\]\] tables, not both/);
    expect(() => parseJob("x", '[[task]]\nkey = "a"\ntarget = "a.py"\ndepends_on = ["b"]\n[[task]]\nkey = "b"\ntarget = "b.py"\ndepends_on = ["a"]\n')).toThrow(
      /dependency cycle: a -> b -> a/,
    );
    expect(() => parseJob("x", '[[task]]\nkey = "bad key"\ntarget = "a.py"\n')).toThrow(/characters other than letters/);
    expect(() => parseJob("x", '[[task]]\nkey = "a"\ntarget = "a.py"\n[[task]]\nkey = "a"\ntarget = "b.py"\n')).toThrow(/key "a" is used twice/);
    expect(() => parseJob("x", '[[task]]\nkey = "a"\ntarget = "a.py"\ndepends_on = ["zz"]\n')).toThrow(/"zz", which is not a task/);
    expect(() => parseJob("x", '[[task]]\nkey = "a"\ntarget = "x.csv"\n')).toThrow(/the target is a notebook \(\.py\) or a query file/);
    expect(() => parseJob("x", '[[task]]\nkey = "a"\ntarget = "a.py"\nrun_if = "sometimes"\n')).toThrow(/run_if is one of all_success/);
    expect(() => parseJob("x", '[[task]]\nkey = "a"\ntarget = "a.py"\nmax_retries = 11\n')).toThrow(/max_retries is a whole number between 0 and 10/);
    expect(() => parseJob("x", '[[task]]\nkey = "a"\ntarget = "a.py"\nmax_retries = "2"\n')).toThrow(/max_retries is a number/);
    expect(() => parseJob("x", '[[task]]\nkey = "a"\ntarget = "a.py"\n[task.params]\nx = [1]\n')).toThrow(/params\.x is a string, a number or a boolean/);
    expect(() => parseJob("x", "[task]\nkey = \"a\"\ntarget = \"a.py\"\n")).toThrow(/task is a list of tables/);
  });

  it("refuse a dashboard folder: dashboards schedule their own refreshes", () => {
    expect(() => parseJob("d", 'target = "dashboards/sales"\n')).toThrow(/notebook \(\.py\) or a query file/);
    expect(() => checkJob({ ...spec, tasks: [taskOf("dashboards/sales")] })).toThrow(/notebook \(\.py\) or a query file/);
  });

  it("explain what is wrong with notify", () => {
    expect(() => parseJob("x", 'target = "a.py"\n[[notify]]\non = ["never"]\nwebhook = "https://x.test/h"\n')).toThrow(/notify on is a list of/);
    expect(() => parseJob("x", 'target = "a.py"\n[[notify]]\non = ["failure"]\nwebhook = "ftp://x.test/h"\n')).toThrow(/http or https URL/);
    expect(() => parseJob("x", 'target = "a.py"\n[[notify]]\non = ["failure"]\n')).toThrow(/notify 1 webhook is missing/);
  });

  it("name their files after them", () => {
    expect(jobId("Nightly Sales (v2)")).toBe("nightly_sales_v2");
    expect(jobId("  ")).toBe("job");
  });
});

describe("scheduled runs", () => {
  const at = (iso: string) => new Date(`${iso}Z`);
  it("are due once their time passed since the last one", () => {
    const daily = { ...spec, schedule: "0 6 * * *" };
    expect(due(daily, at("2026-10-07T06:00").getTime(), at("2026-10-08T06:00:20"))).toBe(at("2026-10-08T06:00").getTime());
    expect(due(daily, at("2026-10-08T06:00").getTime(), at("2026-10-08T07:00"))).toBeNull();
    // never seen: wait for the next time; disabled or by hand: never
    expect(due(daily, undefined, at("2026-10-08T06:00"))).toBeNull();
    expect(due({ ...daily, enabled: false }, 0, at("2026-10-08T06:00"))).toBeNull();
    expect(due({ ...daily, schedule: null }, 0, at("2026-10-08T06:00"))).toBeNull();
  });

  it("know when they run next", () => {
    expect(nextScheduled(spec, at("2026-10-08T07:00"))).toBe(at("2026-10-09T06:00").getTime());
    expect(nextScheduled({ ...spec, schedule: null }, at("2026-10-08T07:00"))).toBeNull();
  });
});
