import { describe, expect, it } from "vitest";

import { frameShape } from "./FrameList";

describe("frameShape", () => {
  it("gives a DataFrame's rows and a LazyFrame's columns only", () => {
    const columns = [{ name: "a", type: "Int64" }, { name: "b", type: "Utf8" }];
    expect(frameShape({ name: "df", kind: "DataFrame", rows: 1204, columns })).toBe("1,204 rows × 2 columns");
    expect(frameShape({ name: null, kind: "LazyFrame", rows: null, columns: [columns[0]] })).toBe("1 column");
  });
});
