/**
 * Every function the model language has. A family file exports its list and
 * this file adds the list below: that is all it takes to add a function.
 */

import { AGGREGATE_FUNCTIONS } from "./aggregate";
import { CONTEXT_FUNCTIONS } from "./context";
import type { FnDef } from "./def";
import { LOGIC_FUNCTIONS } from "./logic";
import { MODEL_SHAPING_FUNCTIONS } from "./model";
import { PARAM_FUNCTIONS } from "./params";
import { TIME_FUNCTIONS } from "./time";
import { WINDOW_FUNCTIONS } from "./window";

const ALL: readonly FnDef[] = [
  ...AGGREGATE_FUNCTIONS,
  ...LOGIC_FUNCTIONS,
  ...MODEL_SHAPING_FUNCTIONS,
  ...CONTEXT_FUNCTIONS,
  ...TIME_FUNCTIONS,
  ...WINDOW_FUNCTIONS,
  ...PARAM_FUNCTIONS,
];

export const FUNCTIONS: ReadonlyMap<string, FnDef> = new Map(ALL.map((f) => [f.name, f]));

/** Names the language keeps for later: using one says "not available yet" instead of "unknown". Empty now: every planned function exists. */
export const PLANNED: ReadonlySet<string> = new Set<string>();

/** For the editor's reference panel. */
export const MODEL_FUNCTIONS: readonly { name: string; signature: string; doc: string }[] = ALL.map(({ name, signature, doc }) => ({
  name,
  signature,
  doc,
}));
