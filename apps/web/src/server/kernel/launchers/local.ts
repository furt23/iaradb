import "server-only";

import type { StudioConfig } from "../../config";
import { processTransport } from "../transport";
import { localKernelEnv } from "./localEnv";
import type { Launcher } from "./types";

/**
 * Kernels as child processes of the Studio, in the workspace directory, with an
 * allowlisted environment (see localKernelEnv) and, on top of it, the settings
 * the Studio picks for this kernel in `env`.
 */
export function localLauncher(cfg: StudioConfig, env: Record<string, string> = {}): Launcher {
  return {
    name: "local",
    localRoot: cfg.workspace,
    start: () =>
      processTransport({
        command: cfg.python,
        args: ["-m", "iara.kernel", "--workspace", cfg.workspace],
        cwd: cfg.workspace,
        env: { ...localKernelEnv(process.env), ...env },
      }),
  };
}
