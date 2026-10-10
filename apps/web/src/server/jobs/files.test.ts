import { describe, expect, it } from "vitest";

import { jobToml, parseJob, type JobSpec } from "@/lib/jobs";

import { retargetToml } from "./files";

const SPEC: JobSpec = {
  id: "nightly",
  name: "Nightly",
  target: "notebooks/sales.py",
  schedule: "0 6 * * *",
  cluster: "job",
  instanceType: null,
  timeoutMinutes: 30,
  enabled: true,
};

describe("retargetToml", () => {
  it("gives the same file as writing the job again with the new target", () => {
    const moved = retargetToml(jobToml(SPEC), SPEC.target, "archive/sales.py");
    expect(moved).toBe(jobToml({ ...SPEC, target: "archive/sales.py" }));
    expect(parseJob("nightly", moved).target).toBe("archive/sales.py");
  });

  it("keeps hand-written comments and keys", () => {
    const toml = '# my note\nname = "N"\ntarget = \'notebooks/sales.py\'  # the report\nschedule = "0 6 * * *"\nowner = "me"\n';
    expect(retargetToml(toml, "notebooks/sales.py", "n/s.py")).toBe('# my note\nname = "N"\ntarget = "n/s.py"  # the report\nschedule = "0 6 * * *"\nowner = "me"\n');
  });

  it("keeps Windows line endings", () => {
    const toml = jobToml(SPEC).replaceAll("\n", "\r\n");
    const moved = retargetToml(toml, SPEC.target, "x.py");
    expect(moved).toBe(jobToml({ ...SPEC, target: "x.py" }).replaceAll("\n", "\r\n"));
  });

  it("only changes the target line", () => {
    const toml = 'name = "target = notebooks/sales.py"\ntarget = "notebooks/sales.py"\n';
    expect(retargetToml(toml, "notebooks/sales.py", "b.py")).toBe('name = "target = notebooks/sales.py"\ntarget = "b.py"\n');
  });
});
