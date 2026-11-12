import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DataFrame } from "./dataframe.js";
import type { Expr } from "./expr.js";
import { fromColumns } from "./convert.js";

/** A fresh temporary directory, its file paths, and the function that removes it. */
export async function tempDir(): Promise<{ dir: string; file: (name: string) => string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "iara-test-"));
  return {
    dir,
    file: (name: string) => join(dir, name),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** The values one expression produces over `df`, in row order. */
export async function valuesOf(df: DataFrame, expr: Expr): Promise<unknown[]> {
  const out = await df.select(expr.alias("r"));
  return (await out.toColumns()).r;
}

/** A frame with nulls: integers, floats, strings. */
export function sampleFrame(): Promise<DataFrame> {
  return fromColumns({
    a: [1, 2, 3, 4, null],
    b: [10, 20, 30, 40, 50],
    s: ["apple", "banana", null, "cherry", "date"],
    f: [1.5, -2.25, 0, null, 4],
    g: ["x", "y", "x", "y", "x"],
  });
}
