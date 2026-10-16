import { describe, expect, it } from "vitest";

import { parseAutorun } from "./autorun";

describe("parseAutorun", () => {
  it("keeps the notebooks switched on and ignores anything else", () => {
    expect(parseAutorun('{"a.py": true, "b.py": false, "c.py": 1}')).toEqual({ "a.py": true });
    expect(parseAutorun(null)).toEqual({});
    expect(parseAutorun("not json")).toEqual({});
    expect(parseAutorun("[1]")).toEqual({});
  });
});
