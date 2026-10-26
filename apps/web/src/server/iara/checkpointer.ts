import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

import { MemorySaver } from "@langchain/langgraph";

import { dataDir } from "../compute/store";
import { writeAtomic } from "../workspace/atomic";

type Config = Parameters<MemorySaver["put"]>[0];

/** A thread's file: bytes as base64, and `writes` keyed as MemorySaver keys them. */
interface Saved {
  storage: Record<string, Record<string, [string, string, string | null]>>;
  writes: Record<string, Record<string, [string, string, string, string?]>>;
}

const THREAD_ID = /^[A-Za-z0-9_.-]{1,160}$/;

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const bytes = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/** The thread id as a file name; it comes from outside, so anything else is refused. */
function checked(id: unknown): string {
  if (typeof id !== "string" || !THREAD_ID.test(id) || id.includes("..")) throw new Error("invalid thread id");
  return id;
}

/** The thread of `config`, checked (undefined for a config without one: MemorySaver reports that itself). */
function threadOf(config: Config): string | undefined {
  const id = config.configurable?.thread_id;
  return id === undefined ? undefined : checked(id);
}

/** A MemorySaver that keeps each thread in a JSON file, so a run paused at interrupt() resumes after a restart. Keeps only the latest checkpoint of each namespace. */
export class FileSaver extends MemorySaver {
  private readonly loaded = new Map<string, Promise<void>>();
  private readonly chain = new Map<string, Promise<void>>();
  /** threads deleted while their run still wrote: an aborted run's last writes land after the delete. Turn ids are never reused. */
  private readonly deleted = new Set<string>();

  constructor(private readonly dir: string) {
    super();
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  /** Reads the thread's file into memory, once per thread; calls that overlap share the read. */
  private load(id: string): Promise<void> {
    let p = this.loaded.get(id);
    if (!p) {
      p = this.read(id);
      this.loaded.set(id, p);
      p.catch(() => this.loaded.delete(id));
    }
    return p;
  }

  private async read(id: string): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(this.file(id), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    const saved = JSON.parse(text) as Saved;
    // objects without a prototype, as MemorySaver builds them
    const storage: MemorySaver["storage"][string] = Object.create(null);
    for (const [ns, byId] of Object.entries(saved.storage)) {
      storage[ns] = Object.create(null);
      for (const [cp, [c, m, parent]] of Object.entries(byId)) storage[ns][cp] = [bytes(c), bytes(m), parent ?? undefined];
    }
    this.storage[id] = storage;
    for (const [key, byTask] of Object.entries(saved.writes)) {
      const inner: MemorySaver["writes"][string] = Object.create(null);
      for (const [k, [task, channel, value, taskPath]] of Object.entries(byTask)) inner[k] = [task, channel, bytes(value), taskPath];
      this.writes[key] = inner;
    }
  }

  /** Drops what a resume never reads: older checkpoints of each namespace, and the writes of the ones already dropped. */
  private prune(id: string): void {
    const newest = new Map<string, string>();
    for (const [ns, byId] of Object.entries(this.storage[id] ?? {})) {
      const [last, ...older] = Object.keys(byId).sort().reverse();
      newest.set(ns, last);
      for (const cp of older) delete byId[cp];
    }
    for (const key of Object.keys(this.writes)) {
      const [thread, ns, cp] = JSON.parse(key) as [string, string, string];
      // a write that lands before its checkpoint's put finishes is newer than the stored ones, so it stays
      if (thread === id && cp < (newest.get(ns) ?? "")) delete this.writes[key];
    }
  }

  private async save(id: string): Promise<void> {
    const byNs = this.storage[id];
    if (!byNs || this.deleted.has(id)) return fs.rm(this.file(id), { force: true });
    const saved: Saved = {
      storage: Object.fromEntries(
        Object.entries(byNs).map(([ns, byId]) => [
          ns,
          Object.fromEntries(Object.entries(byId).map(([cp, [c, m, parent]]) => [cp, [b64(c), b64(m), parent ?? null]])),
        ]),
      ),
      writes: Object.fromEntries(
        Object.entries(this.writes)
          .filter(([key]) => (JSON.parse(key) as string[])[0] === id)
          .map(([key, byTask]) => [key, Object.fromEntries(Object.entries(byTask).map(([k, [task, ch, v, tp]]) => [k, [task, ch, b64(v), tp]]))]),
      ),
    };
    await writeAtomic(this.file(id), JSON.stringify(saved));
  }

  /** Writes the thread's state as it is when its turn comes, one write at a time. */
  private flush(id: string): Promise<void> {
    const next = (this.chain.get(id) ?? Promise.resolve()).then(() => this.save(id));
    const tail = next.catch(() => {});
    this.chain.set(id, tail);
    void tail.then(() => this.chain.get(id) === tail && this.chain.delete(id));
    return next;
  }

  private async persist(id: string): Promise<void> {
    if (this.deleted.has(id)) await super.deleteThread(id);
    else this.prune(id);
    await this.flush(id);
  }

  override async getTuple(config: Config) {
    const id = threadOf(config);
    if (id) await this.load(id);
    return super.getTuple(config);
  }

  override async *list(config: Config, options?: Parameters<MemorySaver["list"]>[1]) {
    const id = threadOf(config);
    if (id) await this.load(id);
    yield* super.list(config, options);
  }

  override async put(config: Config, checkpoint: Parameters<MemorySaver["put"]>[1], metadata: Parameters<MemorySaver["put"]>[2]) {
    const id = threadOf(config);
    if (id) await this.load(id);
    const out = await super.put(config, checkpoint, metadata);
    if (id) await this.persist(id);
    return out;
  }

  override async putWrites(config: Config, writes: Parameters<MemorySaver["putWrites"]>[1], taskId: string, taskPath?: string) {
    const id = threadOf(config);
    if (id) await this.load(id);
    await super.putWrites(config, writes, taskId, taskPath);
    if (id) await this.persist(id);
  }

  override async deleteThread(threadId: string) {
    const id = checked(threadId);
    await this.load(id);
    this.deleted.add(id);
    await super.deleteThread(id);
    await this.flush(id);
    this.loaded.delete(id);
  }
}

const globalForSaver = globalThis as unknown as { __iaraSaver?: FileSaver };

/** The saver Iara's graph uses (one per process, survives dev module reloads via globalThis): <dataDir()>/iara/checkpoints */
export function iaraSaver(): FileSaver {
  return (globalForSaver.__iaraSaver ??= new FileSaver(path.join(dataDir(), "iara", "checkpoints")));
}
