import type { CatalogChange, RunRequest, WidgetsState } from "@workhouse/protocol";

import { authErrorResponse, requireUser } from "@/server/auth/session";
import type { KernelClient } from "@/server/kernel/client";
import { normalizeRelative } from "@/server/kernel/keys";
import { kernels } from "@/server/kernel/manager";
import { eventStream } from "@/server/stream/sse";
import { applyCatalogChanges } from "@/server/workspace/catalogChanges";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Runs notebook cells or a scratch SQL query, streaming kernel events
 * (`cell.state`, `cell.stream`, `progress`, `catalog.changed`) and finally
 * `done` or `failed`. Catalog changes are written to workhouse.toml first.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    await requireUser();
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    throw e;
  }
  const body = (await req.json()) as RunRequest;
  return eventStream(async (send) => {
    const changes: CatalogChange[] = [];
    const forward = (event: string, data: unknown) => {
      if (event === "catalog.changed") changes.push(data as CatalogChange);
      // a restarted kernel gets the values back when its notebook reopens
      else if (event === "widgets.changed" && body.kind !== "sql") kernels.rememberWidgets(body.path, (data as WidgetsState).values);
      send(event, data);
    };
    let kernel: KernelClient | null = null;
    try {
      let result: unknown;
      if (body.kind === "notebook") {
        kernel = await kernels.notebookForRun(normalizeRelative(body.path));
        result = await kernel.request("notebook.run", { cells: body.cells, cell_ids: body.cellIds, autorun: body.autorun === true }, forward);
      } else if (body.kind === "widget") {
        const path = normalizeRelative(body.path);
        kernel = await kernels.notebookForRun(path);
        result = await kernel.request("widgets.set", { notebook: path, name: body.name, value: body.value, cells: body.cells }, forward);
      } else if (body.kind === "sql") {
        kernel = kernels.workspace();
        result = await kernel.request("sql.run", { query: body.query, params: body.params, param_types: body.param_types }, forward);
      } else {
        throw new Error("unknown run request");
      }
      await applyCatalogChanges(changes, kernel);
      send("done", result);
    } catch (e) {
      // what the statements did before the failure still counts
      await applyCatalogChanges(changes, kernel).catch(() => {});
      const err = e as Error & { type?: string };
      send("failed", { type: err.type ?? err.name, message: err.message });
    }
  });
}
