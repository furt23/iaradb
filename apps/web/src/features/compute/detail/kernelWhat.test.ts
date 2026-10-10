import { describe, expect, it } from "vitest";

import { kernelWhat } from "./kernelWhat";

describe("kernelWhat", () => {
  it("names what a kernel serves", () => {
    expect(kernelWhat("workspace")).toEqual({ kind: "workspace" });
    expect(kernelWhat("notebook:analysis/sales.py")).toEqual({ kind: "notebook", path: "analysis/sales.py" });
    expect(kernelWhat("job:r-1")).toEqual({ kind: "job", run: "r-1" });
  });
});
