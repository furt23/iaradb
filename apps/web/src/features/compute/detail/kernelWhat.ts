import { type KernelKey, notebookPath, WORKSPACE_KERNEL } from "@/server/kernel/keys";

/** What a kernel serves, from its key. */
export type KernelWhat = { kind: "workspace" } | { kind: "notebook"; path: string } | { kind: "job"; run: string };

export function kernelWhat(key: KernelKey): KernelWhat {
  if (key === WORKSPACE_KERNEL) return { kind: "workspace" };
  const path = notebookPath(key);
  if (path !== null) return { kind: "notebook", path };
  return { kind: "job", run: key.slice("job:".length) };
}
