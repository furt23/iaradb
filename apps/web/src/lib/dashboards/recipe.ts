/** `datasets/<name>.recipe.json`: Data Wrangler steps over a catalog table, no code (pure). */

import type { WrangleStep } from "@iara/protocol";

import type { Recipe } from "./types";

type Obj = Record<string, unknown>;

function object(v: unknown, what: string): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} is an object`);
  return v as Obj;
}

function step(v: unknown, i: number): WrangleStep {
  const what = `step ${i + 1}`;
  const { id, label, enabled, op } = object(v, what);
  if (typeof id !== "string" || typeof label !== "string" || typeof enabled !== "boolean") throw new Error(`${what}: id and label are text, enabled is true or false`);
  const o = object(op, `${what}: op`);
  if (typeof o.kind !== "string" || !o.kind) throw new Error(`${what}: op kind is missing`);
  return { id, label, enabled, op: o as WrangleStep["op"] };
}

/** The recipe of a value of any kind (the parsed file, or an action's input): checked, rebuilt with the known keys only. */
export function checkRecipe(value: unknown): Recipe {
  const c = object(value, "a recipe");
  const { table } = object(c.source, "source");
  if (typeof table !== "string" || !table.trim()) throw new Error("source table is missing");
  if (!Array.isArray(c.steps)) throw new Error("steps is a list");
  return { source: { table }, steps: c.steps.map(step) };
}

/** The recipe of a `.recipe.json` file. */
export function parseRecipe(text: string): Recipe {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(`not valid JSON: ${(e as Error).message}`);
  }
  return checkRecipe(value);
}

export function recipeJson(r: Recipe): string {
  return `${JSON.stringify({ source: r.source, steps: r.steps }, null, 2)}\n`;
}
