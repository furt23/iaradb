import "server-only";

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** A kernel's byte pipe: JSON lines in and out, stderr lines for logs. */
export interface Transport {
  readonly pid: number | undefined;
  onLine(cb: (line: string) => void): void;
  onStderr(cb: (line: string) => void): void;
  /** called once, when the pipe closes (process exit, ssh drop, spawn failure) */
  onExit(cb: (reason: string) => void): void;
  write(line: string): void;
  kill(): void;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** A child process as a transport (a local kernel, or `ssh` to a remote one). */
export function processTransport(spec: SpawnSpec): Transport {
  const proc = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env ?? process.env, windowsHide: true });
  let exitCb: ((reason: string) => void) | null = null;
  let exited: string | null = null;
  const exit = (reason: string) => {
    if (exited !== null) return;
    exited = reason;
    exitCb?.(reason);
  };
  proc.on("exit", (code, signal) => exit(`exited (code ${code ?? signal})`));
  proc.on("error", (err) => exit(`could not start ${spec.command}: ${err.message}`));
  proc.stdin.on("error", () => {}); // a dead process: reported through "exit"
  return {
    pid: proc.pid,
    onLine: (cb) => void createInterface({ input: proc.stdout }).on("line", cb),
    onStderr: (cb) => void createInterface({ input: proc.stderr }).on("line", cb),
    onExit(cb) {
      exitCb = cb;
      if (exited !== null) cb(exited);
    },
    write: (line) => void proc.stdin.write(line),
    kill: () => void proc.kill(),
  };
}
