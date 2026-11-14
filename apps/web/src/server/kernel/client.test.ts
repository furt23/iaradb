import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION, type KernelInfo } from "@iara/protocol";

import { checkProtocol } from "./bootstrap";
import { KernelClient } from "./client";
import type { Transport } from "./transport";

type Request = { id: number; method: string; params: Record<string, unknown> };

/** A scripted kernel: answers each request with `respond`. */
function fakeTransport(respond: (r: Request, t: FakeTransport) => unknown) {
  const t = {
    pid: 42,
    sent: [] as Request[],
    line: (_: string) => {},
    exit: (_: string) => {},
    onLine(cb: (line: string) => void) {
      t.line = cb;
    },
    onStderr() {},
    onExit(cb: (reason: string) => void) {
      t.exit = cb;
    },
    write(line: string) {
      const r = JSON.parse(line) as Request;
      t.sent.push(r);
      const result = respond(r, t);
      if (result !== undefined) queueMicrotask(() => t.emit({ id: r.id, result }));
    },
    kill() {},
    emit(msg: unknown) {
      t.line(JSON.stringify(msg));
    },
    announce(info: Partial<KernelInfo> = {}) {
      t.emit({ event: "kernel.ready", request: null, data: { protocol: PROTOCOL_VERSION, name: "w", tables: [], ...info } });
    },
  };
  return t;
}
type FakeTransport = ReturnType<typeof fakeTransport>;

const asTransport = (t: FakeTransport) => t as unknown as Transport;

describe("KernelClient", () => {
  it("bootstraps before serving requests", async () => {
    const t = fakeTransport((r) => (r.method === "workspace.configure" ? { protocol: PROTOCOL_VERSION, name: "configured" } : { ok: r.method }));
    const k = new KernelClient({
      transport: asTransport(t),
      label: "t",
      localRoot: null,
      bootstrap: (kernel, info) => (checkProtocol(info), kernel.call("workspace.configure", { toml: "x" })),
    });
    const pending = k.request("ping", {});
    t.announce();
    await expect(pending).resolves.toEqual({ ok: "ping" });
    expect((await k.ready).name).toBe("configured");
    expect(t.sent.map((r) => r.method)).toEqual(["workspace.configure", "ping"]);
  });

  it("refuses a kernel speaking another protocol", async () => {
    const t = fakeTransport(() => ({}));
    const k = new KernelClient({ transport: asTransport(t), label: "t", localRoot: null, bootstrap: async (_, info) => (checkProtocol(info), info) });
    t.announce({ protocol: PROTOCOL_VERSION - 1, host: "ip-10-0-0-1" });
    await expect(k.request("ping", {})).rejects.toThrow(/ip-10-0-0-1 speaks protocol 1, the Studio 2/);
  });

  it("routes events to their request and fails pending ones when the pipe drops", async () => {
    const t = fakeTransport(() => undefined); // never answers
    const k = new KernelClient({ transport: asTransport(t), label: "t", localRoot: null });
    t.announce();
    const events: unknown[] = [];
    const run = k.request("notebook.run", { cells: [], cell_ids: null }, (e, d) => events.push([e, d]));
    await new Promise((r) => setTimeout(r, 0));
    t.emit({ event: "cell.state", request: t.sent[0].id, data: { cell_id: "a" } });
    t.emit({ event: "cell.state", request: 999, data: { cell_id: "other" } });
    t.exit("exited (code 255)");
    await expect(run).rejects.toThrow(/kernel exited/);
    expect(events).toEqual([["cell.state", { cell_id: "a" }]]);
    expect(k.alive).toBe(false);
  });

  it("hands a history event to onHistory with the request's user, and not to the request's listener", async () => {
    const t = fakeTransport(() => undefined);
    const runs: unknown[] = [];
    const k = new KernelClient({ transport: asTransport(t), label: "t", localRoot: null, onHistory: (entry, by) => runs.push([entry.query, by]) });
    t.announce();
    const events: unknown[] = [];
    const run = k.request("sql.run", { query: "SELECT 1" }, (e) => events.push(e), "ana@example.com");
    await new Promise((r) => setTimeout(r, 0));
    t.emit({ event: "history", request: t.sent[0].id, data: { query: "SELECT 1" } });
    t.emit({ id: t.sent[0].id, result: { type: "table" } });
    await expect(run).resolves.toEqual({ type: "table" });
    expect(runs).toEqual([["SELECT 1", "ana@example.com"]]);
    expect(events).toEqual([]);
  });
});
