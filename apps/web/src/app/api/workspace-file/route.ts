import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import { normalizeRelative } from "@/server/kernel/keys";
import { resolveWorkspacePath } from "@/server/workspace/files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Download a workspace file (the file tree's "Download"). */
export async function GET(req: Request): Promise<Response> {
  let file: string;
  try {
    const rel = normalizeRelative(new URL(req.url).searchParams.get("path") ?? "");
    if (rel.split("/").includes(".git")) throw new Error("not available");
    file = resolveWorkspacePath(rel);
    if (!fs.statSync(file).isFile()) throw new Error("not a file");
  } catch (e) {
    return new Response((e as Error).message, { status: 404 });
  }
  const body = Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(fs.statSync(file).size),
      "Content-Disposition": `attachment; filename="${path.basename(file).replaceAll('"', "")}"`,
    },
  });
}
