import { describe, expect, it } from "vitest";

import { isNumericType, typeLabel } from "./format";

describe("typeLabel", () => {
  it("names Arrow's and the engine's spellings alike", () => {
    for (const t of ["string", "large_string", "string_view", "Utf8", "LargeUtf8", "Utf8View"]) expect(typeLabel(t)).toBe("text");
    for (const t of ["int8", "int64", "uint32", "Int64", "UInt16"]) expect(typeLabel(t)).toBe("integer");
    for (const t of ["float", "double", "halffloat", "Float32", "Float64"]) expect(typeLabel(t)).toBe("float");
    expect(typeLabel("bool")).toBe("boolean");
    expect(typeLabel("Boolean")).toBe("boolean");
  });

  it("keeps what matters of parameterized types", () => {
    expect(typeLabel("decimal128(10, 2)")).toBe("decimal(10,2)");
    expect(typeLabel("Decimal128(38, 9)")).toBe("decimal(38,9)");
    expect(typeLabel("date32[day]")).toBe("date");
    expect(typeLabel("Date32")).toBe("date");
    expect(typeLabel("timestamp[us]")).toBe("timestamp");
    expect(typeLabel("Timestamp(µs)")).toBe("timestamp");
    expect(typeLabel("timestamp[us, tz=UTC]")).toBe("timestamp with time zone");
    expect(typeLabel('Timestamp(Microsecond, Some("UTC"))')).toBe("timestamp with time zone");
    expect(typeLabel("list<item: int64>")).toBe("list of integer");
    expect(typeLabel("List(Int64)")).toBe("list");
    expect(typeLabel("struct<a: int64>")).toBe("struct");
    expect(typeLabel("dictionary<values=string, indices=int32, ordered=0>")).toBe("text");
    expect(typeLabel("binary_view")).toBe("binary");
  });

  it("leaves an unknown type as it is", () => {
    expect(typeLabel("geometry")).toBe("geometry");
  });
});

describe("isNumericType", () => {
  it("accepts both spellings", () => {
    expect(isNumericType("int64")).toBe(true);
    expect(isNumericType("Int64")).toBe(true);
    expect(isNumericType("Decimal128(10, 2)")).toBe(true);
    expect(isNumericType("Utf8View")).toBe(false);
  });
});
