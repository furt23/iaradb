/**
 * Every function the model language has. A family file exports its list and
 * this file adds the list below: that is all it takes to add a function.
 */

import { AGGREGATE_FUNCTIONS } from "./aggregate";
import type { FnDef } from "./def";
import { LOGIC_FUNCTIONS } from "./logic";
import { MODEL_SHAPING_FUNCTIONS } from "./model";

const ALL: readonly FnDef[] = [...AGGREGATE_FUNCTIONS, ...LOGIC_FUNCTIONS, ...MODEL_SHAPING_FUNCTIONS];

export const FUNCTIONS: ReadonlyMap<string, FnDef> = new Map(ALL.map((f) => [f.name, f]));

/** Names the language keeps for later: using one says "not available yet" instead of "unknown". */
export const PLANNED: ReadonlySet<string> = new Set([
  "calculate", "all_", "ytd", "qtd", "mtd", "previous_year", "previous_period", "running_total", "rolling", "rank", "switch", "param", "calendar",
]);

/** For the editor's reference panel. */
export const MODEL_FUNCTIONS: readonly { name: string; signature: string; doc: string }[] = ALL.map(({ name, signature, doc }) => ({
  name,
  signature,
  doc,
}));
