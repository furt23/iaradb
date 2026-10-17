import "server-only";

import type { StudioConfig } from "../../config";
import { processTransport } from "../transport";
import { localKernelEnv } from "./localEnv";
import type { Launcher } from "./types";

/** Kernels as child processes of the Studio, in the workspace directory, with an allowlisted environment (see localKernelEnv). */
export function localLauncher(cfg: StudioConfig): Launcher {
  return {
    name: "local",
    localRoot: cfg.workspace,
    start: () =>
      processTransport({
        command: cfg.python,
        args: ["-m", "iara.kernel", "--workspace", cfg.workspace],
        cwd: cfg.workspace,
        env: localKernelEnv(process.env),
      }),
  };
}
