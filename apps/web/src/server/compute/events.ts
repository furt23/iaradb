import fs from "node:fs";
import path from "node:path";

/**
 * What happened to a cluster, for its Event log: one JSON line per event in
 * `<cluster-events>/<clusterId>.jsonl`. A file keeps its last KEEP_EVENTS
 * lines and is compacted once it holds twice as many. The files are injected
 * (see EventFiles), so the log is testable without a disk.
 */

export const CLUSTER_EVENT_KINDS = [
  "created",
  "edited",
  "start",
  "running",
  "terminate",
  "auto-terminate",
  "terminated",
  "error",
  "attached",
  "detached",
  "cloned",
] as const;

export type ClusterEventKind = (typeof CLUSTER_EVENT_KINDS)[number];

export interface ClusterEvent {
  /** ms since the epoch */
  at: number;
  kind: ClusterEventKind;
  message: string;
}

export interface EventFiles {
  append(file: string, text: string): void;
  /** the file's text (null when there is no file) */
  read(file: string): string | null;
  write(file: string, text: string): void;
  remove(file: string): void;
}

export interface EventLogDeps {
  dir: string;
  files: EventFiles;
}

export const KEEP_EVENTS = 500;
const MAX_MESSAGE = 1000;
const CLUSTER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class ClusterEventLog {
  /** lines per file, counted once in this process and kept up to date after */
  private readonly counts = new Map<string, number>();

  constructor(private readonly d: EventLogDeps) {}

  /** Append an event (the file is compacted when it grows past twice KEEP_EVENTS). */
  record(clusterId: string, event: ClusterEvent): void {
    const file = this.fileOf(clusterId);
    const line = JSON.stringify({ at: event.at, kind: event.kind, message: event.message.slice(0, MAX_MESSAGE) });
    this.d.files.append(file, `${line}\n`);
    const known = this.counts.get(file);
    let count = known === undefined ? this.linesOf(file).length : known + 1;
    if (count >= 2 * KEEP_EVENTS) {
      this.d.files.write(file, this.linesOf(file).slice(-KEEP_EVENTS).join("\n") + "\n");
      count = KEEP_EVENTS;
    }
    this.counts.set(file, count);
  }

  /** The last KEEP_EVENTS events of a cluster, newest first. */
  list(clusterId: string): ClusterEvent[] {
    return this.linesOf(this.fileOf(clusterId))
      .slice(-KEEP_EVENTS)
      .map(parseEvent)
      .filter((e): e is ClusterEvent => e !== null)
      .reverse();
  }

  /** Drop the log of a cluster that is gone. */
  forget(clusterId: string): void {
    const file = this.fileOf(clusterId);
    this.d.files.remove(file);
    this.counts.delete(file);
  }

  private fileOf(clusterId: string): string {
    if (!CLUSTER_ID.test(clusterId)) throw new Error(`invalid cluster id ${clusterId}`);
    return path.join(this.d.dir, `${clusterId}.jsonl`);
  }

  private linesOf(file: string): string[] {
    return (this.d.files.read(file) ?? "").split("\n").filter((l) => l.trim() !== "");
  }
}

function parseEvent(line: string): ClusterEvent | null {
  try {
    const e = JSON.parse(line) as Partial<ClusterEvent>;
    const known = typeof e.kind === "string" && (CLUSTER_EVENT_KINDS as readonly string[]).includes(e.kind);
    return typeof e.at === "number" && known && typeof e.message === "string" ? { at: e.at, kind: e.kind as ClusterEventKind, message: e.message } : null;
  } catch {
    return null; // a torn or foreign line
  }
}

/** The Studio's disk (the directory is created on first write). */
export const diskEventFiles: EventFiles = {
  append(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, text, { mode: 0o600 });
  },
  read(file) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  },
  write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  },
  remove(file) {
    fs.rmSync(file, { force: true });
  },
};
