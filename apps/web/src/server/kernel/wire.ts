/** Parsing of the kernel's JSON-lines messages (pure; unit tested). */

import type { KernelEventName } from "@workhouse/protocol";

export type WireMessage =
  | { kind: "result"; id: number | null; result: unknown }
  | { kind: "error"; id: number | null; error: { type: string; message: string } }
  | { kind: "event"; event: KernelEventName; request: number | null; data: unknown };

export function parseMessage(line: string): WireMessage | null {
  const text = line.trim();
  if (!text) return null;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  if (typeof msg.event === "string") {
    return {
      kind: "event",
      event: msg.event as KernelEventName,
      request: typeof msg.request === "number" ? msg.request : null,
      data: msg.data,
    };
  }
  const id = typeof msg.id === "number" ? msg.id : null;
  if ("error" in msg) {
    const err = (msg.error ?? {}) as { type?: string; message?: string };
    return { kind: "error", id, error: { type: err.type ?? "Error", message: err.message ?? "unknown error" } };
  }
  if ("result" in msg) return { kind: "result", id, result: msg.result };
  return null;
}
