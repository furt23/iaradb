import { describe, expect, it } from "vitest";

import { carriesField, encodeField, FIELD_MIME, parseField } from "./fieldDrag";

describe("fieldDrag", () => {
  it("round-trips a field", () => {
    const measure = { kind: "measure", dataset: "orders", name: "revenue" } as const;
    expect(parseField(encodeField(measure))).toEqual(measure);
    expect(parseField(encodeField({ kind: "column", dataset: "orders", name: "region" }))).toEqual({ kind: "column", dataset: "orders", name: "region" });
  });

  it("refuses anything that is not a field", () => {
    for (const raw of ["", "nope", "null", "[]", '{"kind":"row","dataset":"a","name":"b"}', '{"kind":"column","dataset":1,"name":"b"}', '{"kind":"column","dataset":"a","name":""}']) {
      expect(parseField(raw)).toBeNull();
    }
  });

  it("knows a drag of a field by its type", () => {
    expect(carriesField(["text/plain", FIELD_MIME])).toBe(true);
    expect(carriesField(["Files"])).toBe(false);
  });
});
