/** Params: values a dashboard filter can set, `:name` in the SQL. */

import type { Expr } from "../ast";
import { bind, fail, type FnDef } from "./def";

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A number (`-1` too) or a string: what a param starts as. */
function defaultOf(node: Expr): number | string {
  if (node.kind === "str") return node.value;
  const signed = node.kind === "unary" && node.op !== "not" ? node : null;
  const num = signed ? signed.operand : node;
  if (num.kind === "num" && Number.isFinite(Number(num.value))) return signed?.op === "-" ? -Number(num.value) : Number(num.value);
  return fail(node, "the default must be a number or a string in quotes");
}

export const PARAM_FUNCTIONS: readonly FnDef[] = [
  {
    kind: "expr",
    name: "param",
    signature: 'param("name", default)',
    doc: 'A value a dashboard filter can change, else `default` (a number or a string). Written as `rate = param("rate", 0.1)` the name is the same as the one given, or used inline as param("rate", 0.1). Example: discount = param("discount", 0.1)',
    check(call, cx) {
      const a = bind(call, { params: ["name", "default"], required: 2, positional: 2 });
      if (a.name.kind !== "str") fail(a.name, 'the name must be a string in quotes, e.g. param("discount", 0.1)');
      const name = a.name.value;
      if (name.startsWith("_")) fail(a.name, `param names starting with _ are reserved: "${name}"`);
      if (!IDENTIFIER.test(name)) fail(a.name, `a param name is letters, digits and _, starting with a letter: "${name}"`);
      if (cx.assigned !== undefined && cx.assigned !== name) {
        fail(a.name, `the param name has to be the same as the name it is assigned to: ${cx.assigned} = param("${cx.assigned}", ...)`);
      }
      const value = defaultOf(a.default);
      const known = cx.params.find((p) => p.name === name);
      if (known && known.default !== value) fail(call, `param "${name}" already has the default ${JSON.stringify(known.default)} on line ${known.span.line}`);
      if (!known) cx.params.push({ name, default: value, span: call.span });
      return { level: "scalar", sql: [`:${name}`], datasets: [], ...(typeof value === "string" && { text: true }) };
    },
  },
];
