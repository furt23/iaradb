import "server-only";

import type { StudioConfig } from "../../config";
import { processTransport } from "../transport";
import type { Launcher } from "./types";

/** Kernels as child processes of the Studio, in the workspace directory. */
export function localLauncher(cfg: StudioConfig): Launcher {
  return {
    name: "local",
    localRoot: cfg.workspace,
    start: () =>
      processTransport({
        command: cfg.python,
        args: ["-m", "workhouse.kernel", "--workspace", cfg.workspace],
        cwd: cfg.workspace,
        env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
      }),
  };
}
