import type { AssistRequest, CellKind } from "@iara/protocol";

import type { EditorAssist } from "@/features/editor/assist";
import type { ActionResult } from "@/server/result";

/** Ask the assist endpoint; failures and stale answers become null. */
async function ask<T>(req: AssistRequest, signal: AbortSignal): Promise<T | null> {
  try {
    const res = await fetch("/api/assist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req), signal });
    const r = (await res.json()) as ActionResult<T | null>;
    return r.ok ? r.data : null;
  } catch {
    return null;
  }
}

/** Kernel-backed completions, signature help and diagnostics for one cell. */
export function cellAssist(path: string, cellId: string, kind: CellKind): EditorAssist | undefined {
  if (kind === "markdown") return undefined;
  const base = { path, cellId };
  const python = kind === "python";
  return {
    complete: python ? (code, cursor, signal) => ask({ op: "complete", ...base, code, cursor }, signal) : undefined,
    signature: python ? (code, cursor, signal) => ask({ op: "signature", ...base, code, cursor }, signal) : undefined,
    lint: (code, signal) => ask({ op: "lint", ...base, kind, code }, signal),
  };
}
