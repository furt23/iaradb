import "server-only";

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { utils } from "ssh2";

import type { ClusterRecord } from "./types";

/**
 * The Studio's own state (not the workspace's): clusters, which notebook is
 * attached to which cluster, the default cluster, and the SSH identity the
 * Studio uses to reach its machines. One JSON file plus a private key in
 * `IARA_STUDIO_DATA` (default ~/.iara/studio).
 */

export interface StudioState {
  installationId: string;
  clusters: ClusterRecord[];
  /** notebook path -> cluster id */
  attachments: Record<string, string>;
  defaultCluster?: string;
}

export interface Identity {
  privateKey: string;
  /** OpenSSH `authorized_keys` line */
  publicKey: string;
}

export function dataDir(): string {
  return process.env.IARA_STUDIO_DATA || path.join(os.homedir(), ".iara", "studio");
}

function writeAtomic(file: string, text: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

export class Store {
  private cache: StudioState | null = null;

  constructor(private readonly dir: string) {}

  private get file(): string {
    return path.join(this.dir, "clusters.json");
  }

  read(): StudioState {
    if (this.cache) return this.cache;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<StudioState>;
      this.cache = { installationId: data.installationId ?? crypto.randomUUID(), clusters: data.clusters ?? [], attachments: data.attachments ?? {}, defaultCluster: data.defaultCluster };
    } catch {
      this.cache = { installationId: crypto.randomUUID(), clusters: [], attachments: {} };
    }
    return this.cache;
  }

  /** Change the state and save it (synchronously: no interleaving between readers and writers). */
  update<T>(fn: (s: StudioState) => T): T {
    const state = structuredClone(this.read());
    const out = fn(state);
    writeAtomic(this.file, JSON.stringify(state, null, 2));
    this.cache = state;
    return out;
  }

  cluster(id: string): ClusterRecord | undefined {
    return this.read().clusters.find((c) => c.id === id);
  }

  updateCluster(id: string, fn: (c: ClusterRecord) => void): ClusterRecord {
    return this.update((s) => {
      const c = s.clusters.find((x) => x.id === id);
      if (!c) throw new Error(`unknown cluster ${id}`);
      fn(c);
      return structuredClone(c);
    });
  }

  /** The Studio's SSH identity, created on first use (only the Studio holds the private key). */
  identity(): Identity {
    const keyFile = path.join(this.dir, "id_ed25519");
    if (!fs.existsSync(keyFile)) {
      const pair = utils.generateKeyPairSync("ed25519", { comment: "iara-studio" });
      writeAtomic(keyFile, pair.private);
      writeAtomic(`${keyFile}.pub`, pair.public, 0o644);
    }
    return { privateKey: fs.readFileSync(keyFile, "utf8"), publicKey: fs.readFileSync(`${keyFile}.pub`, "utf8").trim() };
  }
}
