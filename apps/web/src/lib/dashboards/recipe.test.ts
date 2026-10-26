import { describe, expect, it } from "vitest";

import { parseRecipe, recipeJson } from "./recipe";

const step = { id: "s1", label: "Filter rows", enabled: true, op: { kind: "filter", column: "region", value: "EU" } };
const recipe = { source: { table: "main.sales" }, steps: [step] };

describe("parseRecipe", () => {
  it("reads a recipe and drops the keys it does not know", () => {
    const text = JSON.stringify({ ...recipe, extra: 1, source: { table: "main.sales", x: 1 }, steps: [{ ...step, y: 2 }] });
    expect(parseRecipe(text)).toEqual(recipe);
  });

  it("takes a recipe without steps, and a step that is off", () => {
    expect(parseRecipe('{"source":{"table":"t"},"steps":[]}')).toEqual({ source: { table: "t" }, steps: [] });
    expect(parseRecipe(JSON.stringify({ ...recipe, steps: [{ ...step, enabled: false }] })).steps[0].enabled).toBe(false);
  });

  it.each([
    ["not json", /not valid JSON/],
    ["[]", /a recipe is an object/],
    ["{}", /source is an object/],
    ['{"source":{"table":" "},"steps":[]}', /source table is missing/],
    ['{"source":{"table":3},"steps":[]}', /source table is missing/],
    ['{"source":{"table":"t"}}', /steps is a list/],
    ['{"source":{"table":"t"},"steps":{}}', /steps is a list/],
    ['{"source":{"table":"t"},"steps":[1]}', /step 1 is an object/],
    [JSON.stringify({ ...recipe, steps: [{ ...step, id: 1 }] }), /step 1: id and label/],
    [JSON.stringify({ ...recipe, steps: [step, { ...step, label: undefined }] }), /step 2: id and label/],
    [JSON.stringify({ ...recipe, steps: [{ ...step, enabled: "yes" }] }), /enabled is true or false/],
    [JSON.stringify({ ...recipe, steps: [{ ...step, op: "filter" }] }), /step 1: op is an object/],
    [JSON.stringify({ ...recipe, steps: [{ ...step, op: { kind: "" } }] }), /op kind is missing/],
    [JSON.stringify({ ...recipe, steps: [{ ...step, op: { kind: 1 } }] }), /op kind is missing/],
  ])("refuses %s", (text, error) => {
    expect(() => parseRecipe(text)).toThrow(error);
  });
});

describe("recipeJson", () => {
  it("round-trips, with 2-space indent, a trailing newline and only the known keys", () => {
    const text = recipeJson({ ...recipe, extra: 1 } as never);
    expect(text.startsWith('{\n  "source"')).toBe(true);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).not.toContain("extra");
    expect(parseRecipe(text)).toEqual(recipe);
  });
});
