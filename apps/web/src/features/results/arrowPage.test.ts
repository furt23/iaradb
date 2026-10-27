import { bool, float32, float64, int32, int64, tableFromArrays, tableToIPC, utf8, type Table } from "@uwdata/flechette";
import { describe, expect, it } from "vitest";

import { pageFromArrow } from "./arrowPage";

/** the IPC stream the kernel would send for `table`, its columns in `json` marked as nested values */
function ipc(table: Table, json: string[] = []): Uint8Array {
  for (const f of table.schema.fields) if (json.includes(f.name)) f.metadata = new Map([["iara.cell", "json"]]);
  return tableToIPC(table, { format: "stream" })!;
}

describe("page from Arrow", () => {
  it("gives the rows result.page gives: numbers, text, booleans and nulls as they are, in column order", () => {
    const table = tableFromArrays(
      {
        id: new BigInt64Array([1n, -(2n ** 53n - 1n), 2n ** 53n - 1n]),
        n: [7, null, -3],
        ratio: [0.5, 2.25, null],
        name: ["a", null, "c d"],
        ok: [true, false, null],
      },
      { types: { id: int64(), n: int32(), ratio: float32(), name: utf8(), ok: bool() } },
    );
    expect(pageFromArrow(ipc(table), 200, 5000)).toEqual({
      offset: 200,
      total: 5000,
      rows: [
        [1, 7, 0.5, "a", true],
        [-(2 ** 53 - 1), null, 2.25, null, false],
        [2 ** 53 - 1, -3, null, "c d", null],
      ],
    });
  });

  it("writes the floats JSON cannot hold the way Python's str does", () => {
    const table = tableFromArrays({ f: new Float64Array([1.5, NaN, Infinity, -Infinity, 0]), g: [NaN, null, -Infinity, 2, Infinity] }, { types: { g: float64() } });
    expect(pageFromArrow(ipc(table), 0, 5).rows).toEqual([
      [1.5, "nan"],
      ["nan", null],
      ["inf", "-inf"],
      ["-inf", 2],
      [0, "inf"],
    ]);
  });

  it("parses the columns marked as JSON text, and only those", () => {
    const table = tableFromArrays(
      {
        tags: ['["x",1,null]', null, '{"a":{"b":[true,2.5]}}', '"text"', "3"],
        text: ['["not","parsed"]', "{}", null, "null", "3"],
      },
      { types: { tags: utf8(), text: utf8() } },
    );
    expect(pageFromArrow(ipc(table, ["tags"]), 0, 5).rows).toEqual([
      [["x", 1, null], '["not","parsed"]'],
      [null, "{}"],
      [{ a: { b: [true, 2.5] } }, null],
      ["text", "null"],
      [3, "3"],
    ]);
  });

  it("gives an empty page for a stream with no rows", () => {
    const table = tableFromArrays({ a: [] as number[], b: [] as string[] }, { types: { a: int32(), b: utf8() } });
    expect(pageFromArrow(ipc(table), 40, 40)).toEqual({ offset: 40, total: 40, rows: [] });
  });

  it("fails on a 64-bit integer past the safe range instead of rounding it", () => {
    const table = tableFromArrays({ big: new BigInt64Array([2n ** 53n]) });
    expect(() => pageFromArrow(ipc(table), 0, 1)).toThrow();
  });

  it("fails on bytes that are not an Arrow stream", () => {
    expect(() => pageFromArrow(new Uint8Array([1, 2, 3, 4]), 0, 0)).toThrow();
  });
});
