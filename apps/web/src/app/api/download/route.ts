import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import type { KernelClient } from "@/server/kernel/client";
import { normalizeRelative, parseKernelKey } from "@/server/kernel/keys";
import { kernels } from "@/server/kernel/manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CHUNK = 1 << 20;

/** A local kernel's file, straight from disk. */
function localFile(root: string, rel: string): ReadableStream<Uint8Array> {
  const file = path.resolve(root, rel);
  if (!file.startsWith(path.resolve(root) + path.sep) || !fs.statSync(file).isFile()) throw new Error("not a file");
  return Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>;
}

/** A remote kernel's file, pulled in chunks over the kernel protocol. */
function remoteFile(kernel: KernelClient, rel: string): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await kernel.request("file.read", { path: rel, offset, length: CHUNK });
      const bytes = Buffer.from(chunk.data, "base64");
      offset += bytes.length;
      if (bytes.length) controller.enqueue(new Uint8Array(bytes));
      if (chunk.eof || !bytes.length) controller.close();
    },
  });
}

/** Downloads of exported results (only files under `exports/`), from the kernel that wrote them. */
export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  let body: ReadableStream<Uint8Array>;
  let rel: string;
  try {
    rel = normalizeRelative(params.get("path") ?? "");
    if (!rel.startsWith("exports/")) throw new Error("only exports can be downloaded");
    const kernel = kernels.existing(parseKernelKey(params.get("kernel") ?? "workspace"));
    if (!kernel) throw new Error("the kernel that exported this file is no longer running");
    body = kernel.localRoot ? localFile(kernel.localRoot, rel) : remoteFile(kernel, rel);
  } catch (e) {
    return new Response((e as Error).message, { status: 404 });
  }
  return new Response(body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${path.basename(rel).replaceAll('"', "")}"`,
    },
  });
}
