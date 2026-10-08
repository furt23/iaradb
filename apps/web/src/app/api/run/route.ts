import type { RunRequest } from "@workhouse/protocol";

import { normalizeRelative } from "@/server/kernel/keys";
import { kernels } from "@/server/kernel/manager";
import { eventStream } from "@/server/stream/sse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Runs notebook cells or a scratch SQL query, streaming kernel events
 * (`cell.state`, `cell.stream`, `progress`) and finally `done` or `failed`.
 */
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as RunRequest;
  return eventStream(async (send) => {
    const forward = (event: string, data: unknown) => send(event, data);
    try {
      if (body.kind === "notebook") {
        const kernel = await kernels.notebookForRun(normalizeRelative(body.path));
        send("done", await kernel.request("notebook.run", { cells: body.cells, cell_ids: body.cellIds }, forward));
      } else if (body.kind === "sql") {
        send("done", await kernels.workspace().request("sql.run", { query: body.query }, forward));
      } else {
        throw new Error("unknown run request");
      }
    } catch (e) {
      const err = e as Error & { type?: string };
      send("failed", { type: err.type ?? err.name, message: err.message });
    }
  });
}
