import "server-only";

import crypto from "node:crypto";
import { createInterface } from "node:readline";

import { Client, type ClientChannel, type ConnectConfig } from "ssh2";

import type { Transport } from "../transport";

/**
 * SSH from the Studio's server to a cluster machine, in JavaScript (the
 * `ssh2` package: no OpenSSH binary, works on Windows and on hosted servers).
 */

export interface SshEndpoint {
  host: string;
  username: string;
  privateKey: string;
  port?: number;
  /** expected SHA-256 (base64) of the machine's host key; without it, the first key seen is trusted */
  hostKey?: string;
  /** called with the host key's fingerprint when it was not known yet */
  onHostKey?: (fingerprint: string) => void;
}

export function fingerprint(key: Buffer): string {
  return crypto.createHash("sha256").update(key).digest("base64");
}

function connectConfig(ep: SshEndpoint): ConnectConfig {
  return {
    host: ep.host,
    port: ep.port ?? 22,
    username: ep.username,
    privateKey: ep.privateKey,
    readyTimeout: 20_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 4,
    hostVerifier: (key: Buffer) => {
      const fp = fingerprint(key);
      if (ep.hostKey) return fp === ep.hostKey;
      ep.onHostKey?.(fp);
      return true;
    },
  };
}

/** Run one command; resolves with its exit code and output. */
export function sshExec(ep: SshEndpoint, command: string, timeoutMs = 30_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error(`ssh to ${ep.host} timed out`));
    }, timeoutMs);
    conn
      .on("ready", () =>
        conn.exec(command, (err, ch) => {
          if (err) {
            clearTimeout(timer);
            conn.end();
            return reject(err);
          }
          let stdout = "";
          let stderr = "";
          ch.on("data", (d: Buffer) => (stdout += d.toString()));
          ch.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
          ch.on("close", (code: number | null) => {
            clearTimeout(timer);
            conn.end();
            resolve({ code, stdout, stderr });
          });
        }),
      )
      .on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      })
      .connect(connectConfig(ep));
  });
}

/** A kernel on the far end of an SSH session: its stdio is the protocol pipe. */
export function ssh2Transport(ep: SshEndpoint, command: string): Transport {
  const conn = new Client();
  let channel: ClientChannel | null = null;
  const queued: string[] = [];
  let onLine: (line: string) => void = () => {};
  let onStderr: (line: string) => void = () => {};
  let onExit: ((reason: string) => void) | null = null;
  let exited: string | null = null;
  const exit = (reason: string) => {
    if (exited !== null) return;
    exited = reason;
    onExit?.(reason);
    conn.end();
  };
  conn
    .on("ready", () =>
      conn.exec(command, (err, ch) => {
        if (err) return exit(`could not start the kernel over ssh: ${err.message}`);
        channel = ch;
        createInterface({ input: ch }).on("line", (l) => onLine(l));
        createInterface({ input: ch.stderr }).on("line", (l) => onStderr(l));
        ch.on("close", (code: number | null) => exit(`exited (code ${code ?? "?"})`));
        for (const line of queued.splice(0)) ch.write(line);
      }),
    )
    .on("error", (e) => exit(`ssh to ${ep.host}: ${e.message}`))
    .on("close", () => exit(`ssh connection to ${ep.host} closed`))
    .connect(connectConfig(ep));
  return {
    pid: undefined,
    onLine: (cb) => void (onLine = cb),
    onStderr: (cb) => void (onStderr = cb),
    onExit(cb) {
      onExit = cb;
      if (exited !== null) cb(exited);
    },
    write: (line) => void (channel ? channel.write(line) : queued.push(line)),
    kill: () => exit("killed"),
  };
}
