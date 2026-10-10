import { describe, expect, it } from "vitest";

import { due, jobId, jobToml, nextScheduled, parseJob, type JobSpec } from "./jobs";

const spec: JobSpec = {
  id: "nightly_sales",
  name: "Nightly sales",
  target: "notebooks/sales.py",
  schedule: "0 6 * * *",
  cluster: "job",
  instanceType: "m7i-flex.large",
  timeoutMinutes: 60,
  enabled: true,
};

describe("job files", () => {
  it("round-trip", () => {
    const text = jobToml(spec);
    expect(text.startsWith("# A Workhouse job: runs notebooks/sales.py on a schedule")).toBe(true);
    expect(parseJob("nightly_sales", text)).toEqual(spec);
  });

  it("fill in defaults", () => {
    expect(parseJob("q", 'target = "queries/refresh.sql"\n')).toEqual({
      id: "q",
      name: "q",
      target: "queries/refresh.sql",
      schedule: null,
      cluster: "job",
      instanceType: null,
      timeoutMinutes: 60,
      enabled: true,
    });
  });

  it("explain what is wrong", () => {
    expect(() => parseJob("x", "name = 'x'")).toThrow(/target is missing/);
    expect(() => parseJob("x", 'target = "data/x.csv"')).toThrow(/notebook \(\.py\) or a query file/);
    expect(() => parseJob("x", 'target = "a.py"\nschedule = "every day"')).toThrow(/schedule: a schedule has 5 fields/);
    expect(() => parseJob("x", "target = ")).toThrow(/not valid TOML/);
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
