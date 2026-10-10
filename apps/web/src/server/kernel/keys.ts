/**
 * Kernel keys. The workspace kernel serves the catalog, the SQL editor and
 * history; each open notebook gets its own kernel, and so does each job run.
 */

export type KernelKey = "workspace" | `notebook:${string}` | `job:${string}`;

export const WORKSPACE_KERNEL: KernelKey = "workspace";

export function notebookKernel(path: string): KernelKey {
  return `notebook:${normalizeRelative(path)}`;
}

/** A workspace-relative path with forward slashes; rejects escapes. */
export function normalizeRelative(p: string): string {
  const parts = p.replaceAll("\\", "/").split("/").filter((s) => s && s !== ".");
  if (parts.some((s) => s === "..") || /^[a-zA-Z]:/.test(parts[0] ?? "")) {
    throw new Error(`invalid workspace path: ${p}`);
  }
  return parts.join("/");
}

export function jobKernel(runId: string): KernelKey {
  return `job:${runId}`;
}

/** The notebook a kernel key belongs to (null for the workspace kernel). */
export function notebookPath(key: KernelKey): string | null {
  return key.startsWith("notebook:") ? key.slice("notebook:".length) : null;
}

export function parseKernelKey(key: string): KernelKey {
  if (key === WORKSPACE_KERNEL) return key;
  if (key.startsWith("notebook:")) return notebookKernel(key.slice("notebook:".length));
  throw new Error(`invalid kernel key: ${key}`);
}
