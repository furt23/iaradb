import "server-only";

import type { ContextCell, IaraFileContext } from "@/lib/iara/protocol";

import type { Step } from "./state";
import { cutToTokens } from "./tokens";

/** How notebook code reaches the catalog, for the agents that write or read it. */
export const NOTEBOOK_API = `Notebook Python cells: the notebook's setup already defines \`iara\` and \`ws\` (the workspace: the same catalog SQL sees). Never redefine them, and never read a catalog table from its files.
- \`ws.table("main.orders")\` is a catalog table as a LazyFrame.
- \`ws.sql("SELECT ...")\` runs SQL over the catalog and returns a LazyFrame; frames passed as keyword arguments are tables by that name: \`ws.sql("SELECT * FROM t", t=lf)\`.
- \`from iara import functions as F\`, then \`F.col("x")\`, \`F.lit(1)\`; \`lf.filter(...)\`, \`.select(...)\`, \`.with_columns(...)\`, \`.group_by("a").agg(F.col("x").sum().alias("total"), F.col("id").n_unique().alias("n"))\`, \`.join(other, on="k", how="inner")\` (or left_on/right_on), \`.sort("total", descending=True)\`, \`.limit(10)\`, \`.collect()\`.
- A cell's last expression is its output; a frame shows as a table.
Notebook SQL cells run on the same catalog with no setup.`;

const cellText =(c: ContextCell, selected: boolean): string => {
  const head = [`cell ${c.id}`, c.kind, c.name && `"${c.name}"`, c.setup && "read-only", c.status && `status ${c.status}`, selected && "selected"].filter(Boolean).join(", ");
  return [`[${head}]`, c.code, c.output && `output: ${c.output}`].filter(Boolean).join("\n");
};

/** The open file as prompt text: for a notebook its cells in order (id, kind, name, code, output summary, status), the selected cell and the variables; for the SQL editor the query and its last result. Cut to `max` tokens. */
export async function contextText(ctx: IaraFileContext, max = 30_000): Promise<string> {
  const text =
    ctx.surface === "sql"
      ? [`SQL editor ${ctx.path}`, `query:\n${ctx.query || "(empty)"}`, ctx.result && `last result:\n${ctx.result}`]
      : [
          `Notebook ${ctx.path}`,
          ctx.canRun === false && "Its cluster is not running: cells cannot run now. Propose changes with run false and say the user can run them once the cluster is started.",
          ctx.cells.length ? ctx.cells.map((c) => cellText(c, c.id === ctx.selectedCellId)).join("\n\n") : "(no cells)",
          ctx.variables.length && `variables:\n${ctx.variables.map((v) => `${v.name}: ${v.type}${v.summary ? ` = ${v.summary}` : ""}`).join("\n")}`,
        ];
  return cutToTokens(text.filter(Boolean).join("\n\n"), max);
}

/** A function call's result for the history. */
export function resultStep(call: { id: string; name: string }, result: string, isError = false): Step {
  return { type: "function_result", call_id: call.id, name: call.name, result, ...(isError && { is_error: true }) };
}

export function userStep(text: string): Step {
  return { type: "user_input", content: [{ type: "text", text }] };
}
