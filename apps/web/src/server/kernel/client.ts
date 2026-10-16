import "server-only";

import type { KernelEventName, KernelInfo, KernelMethod, ParamsOf, ResultOf } from "@iara/protocol";

import type { Transport } from "./transport";
import { parseMessage } from "./wire";

export type EventListener = (event: KernelEventName, data: unknown) => void;

export class KernelError extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = "KernelError";
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onEvent?: EventListener;
}

export interface KernelOptions {
  transport: Transport;
  /** for logs */
  label: string;
  /** the kernel's workspace directory when on this machine (see Launcher.localRoot) */
  localRoot: string | null;
  readyTimeoutMs?: number;
  /**
   * Runs once the process announced itself, before any other request:
   * checks the protocol version and configures the kernel.
   */
  bootstrap?: (kernel: KernelClient, info: KernelInfo) => Promise<KernelInfo>;
}

const STDERR_TAIL = 40;

/** A kernel process (local or remote) and its request multiplexing. */
export class KernelClient {
  /** the kernel is up and configured */
  readonly ready: Promise<KernelInfo>;
  readonly startedAt = Date.now();
  readonly localRoot: string | null;
  lastUsed = Date.now();
  private readonly started: Promise<KernelInfo>;
  private readonly transport: Transport;
  private readonly pending = new Map<number, Pending>();
  private readonly stderrTail: string[] = [];
  private nextId = 1;
  private exitError: KernelError | null = null;
  private settleStarted!: { resolve(info: KernelInfo): void; reject(e: Error): void };

  constructor(private readonly opts: KernelOptions) {
    this.localRoot = opts.localRoot;
    this.started = new Promise<KernelInfo>((resolve, reject) => {
      this.settleStarted = { resolve, reject };
    });
    this.ready = this.started.then((info) => (opts.bootstrap ? opts.bootstrap(this, info) : info));
    this.ready.catch(() => {}); // observed through request()
    this.transport = opts.transport;
    this.transport.onLine((line) => this.onLine(line));
    this.transport.onStderr((line) => this.onStderr(line));
    this.transport.onExit((reason) => this.onExit(reason));
    const timeout = setTimeout(
      () => this.settleStarted.reject(new KernelError("Timeout", "kernel did not start in time")),
      opts.readyTimeoutMs ?? 30_000,
    );
    this.started.finally(() => clearTimeout(timeout)).catch(() => {});
  }

  get alive(): boolean {
    return this.exitError === null;
  }

  get pid(): number | undefined {
    return this.transport.pid;
  }

  /** a copy of the last lines the kernel wrote to stderr */
  get stderr(): string[] {
    return [...this.stderrTail];
  }

  get busy(): boolean {
    return this.pending.size > 0;
  }

  private onStderr(line: string): void {
    this.stderrTail.push(line);
    if (this.stderrTail.length > STDERR_TAIL) this.stderrTail.shift();
    console.error(`[kernel ${this.opts.label}] ${line}`);
  }

  private onLine(line: string): void {
    const msg = parseMessage(line);
    if (!msg) return;
    if (msg.kind === "event") {
      if (msg.event === "kernel.ready") this.settleStarted.resolve(msg.data as KernelInfo);
      else if (msg.request !== null) this.pending.get(msg.request)?.onEvent?.(msg.event, msg.data);
      return;
    }
    const p = msg.id === null ? undefined : this.pending.get(msg.id);
    if (!p || msg.id === null) return;
    this.pending.delete(msg.id);
    if (msg.kind === "result") p.resolve(msg.result);
    else p.reject(new KernelError(msg.error.type, msg.error.message));
  }

  private onExit(reason: string): void {
    if (this.exitError) return;
    const detail = this.stderrTail.slice(-8).join("\n");
    this.exitError = new KernelError("KernelDied", `kernel ${reason}${detail ? `\n${detail}` : ""}`);
    this.settleStarted.reject(this.exitError);
    for (const p of this.pending.values()) p.reject(this.exitError);
    this.pending.clear();
  }

  /** A request once the kernel is up and configured. */
  async request<M extends KernelMethod>(method: M, params: ParamsOf<M>, onEvent?: EventListener): Promise<ResultOf<M>> {
    await this.ready;
    return this.call(method, params, onEvent);
  }

  /** A request as soon as the process is up (used by the bootstrap). */
  async call<M extends KernelMethod>(method: M, params: ParamsOf<M>, onEvent?: EventListener): Promise<ResultOf<M>> {
    await this.started;
    if (this.exitError) throw this.exitError;
    this.lastUsed = Date.now();
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject, onEvent }));
    this.transport.write(JSON.stringify({ id, method, params }) + "\n");
    try {
      return (await result) as ResultOf<M>;
    } finally {
      this.lastUsed = Date.now();
    }
  }

  /** Ask the kernel to exit; kill it if it does not. */
  shutdown(graceMs = 2000): void {
    if (!this.alive) return;
    try {
      this.transport.write(JSON.stringify({ id: 0, method: "shutdown", params: {} }) + "\n");
    } catch {
      // the pipe is already closed
    }
    setTimeout(() => this.alive && this.transport.kill(), graceMs).unref();
  }
}
