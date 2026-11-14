"use server";

import type { LineageUse, TableLineage } from "@/lib/system/types";
import { displayName, parseTableName } from "@/lib/catalogToml";

import { requireUser } from "../auth/session";
import { attempt, type ActionResult } from "../result";
import { lineageOf } from "../system/lineage";
import { defaultCatalog } from "../workspace/catalog";

/** The writers and readers of a table, `name` as the Data section names it; inputs are display names too. */
export async function tableLineage(name: string): Promise<ActionResult<TableLineage>> {
  return attempt(async () => {
    await requireUser();
    const d = await defaultCatalog();
    const target = parseTableName(name, d);
    if (!target) return { writers: [], readers: [] };
    const lineage = lineageOf(`${target.catalog}.${target.schema}.${target.table}`);
    const shown = (u: LineageUse): LineageUse => ({
      ...u,
      inputs: u.inputs.map((full) => {
        const [catalog, schema, table] = full.split(".");
        return catalog && schema && table ? displayName({ catalog, schema, table }, d) : full;
      }),
    });
    return { writers: lineage.writers.map(shown), readers: lineage.readers.map(shown) };
  });
}
