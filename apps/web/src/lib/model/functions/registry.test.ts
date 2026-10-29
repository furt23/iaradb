import { describe, expect, it } from "vitest";

import { checkModel } from "../check";
import { FUNCTIONS, MODEL_FUNCTIONS, PLANNED } from "./registry";

describe("registry", () => {
  it("lists every function of the first phase", () => {
    expect(MODEL_FUNCTIONS.map((f) => f.name).sort()).toEqual(
      ["avg", "count", "count_distinct", "count_rows", "divide", "if_", "max", "measure", "min", "relate", "sum"],
    );
  });

  it("gives the editor a name, a signature that starts with it, and a doc", () => {
    for (const f of MODEL_FUNCTIONS) {
      expect(Object.keys(f).sort()).toEqual(["doc", "name", "signature"]);
      expect(f.signature.startsWith(`${f.name}(`)).toBe(true);
      expect(f.doc.length).toBeGreaterThan(10);
    }
  });

  it("has unique names, and none of them is a planned one", () => {
    expect(new Set(MODEL_FUNCTIONS.map((f) => f.name)).size).toBe(MODEL_FUNCTIONS.length);
    expect(FUNCTIONS.size).toBe(MODEL_FUNCTIONS.length);
    for (const name of PLANNED) expect(FUNCTIONS.has(name)).toBe(false);
  });

  it("can all be imported", () => {
    const names = [...FUNCTIONS.keys()].join(", ");
    expect(checkModel(`from iara.model import ${names}`, {}).diagnostics).toEqual([]);
  });

  it("documents examples that check", () => {
    const schema = { orders: ["total", "profit", "status", "customer_id"], customers: ["id"] };
    for (const f of MODEL_FUNCTIONS) {
      const example = /Example: (.+)$/.exec(f.doc)?.[1];
      expect(example, `${f.name} has an example`).toBeDefined();
      const source = /^(relate\(|\w+ = )/.test(example!) ? example! : `m = ${example}`;
      expect(checkModel(source, schema).diagnostics, f.name).toEqual([]);
    }
  });
});
