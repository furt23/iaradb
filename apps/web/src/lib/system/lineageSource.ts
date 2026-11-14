import type { LineageSource, QueryLogEntry } from "./types";

/** The source a run belongs to in lineage; null for the Studio's own reads. */
export function sourceOf(entry: Pick<QueryLogEntry, "kernel" | "source">): LineageSource | null {
  const { kernel, source } = entry;
  if (kernel.startsWith("notebook:")) {
    const path = kernel.slice("notebook:".length);
    return { kind: "notebook", id: path, label: path };
  }
  if (kernel.startsWith("job:")) {
    const id = source.replace(/^job /, "");
    return { kind: "job", id, label: id };
  }
  if (kernel.startsWith("dashboard:")) {
    return { kind: "dashboard", id: kernel.slice("dashboard:".length), label: source.replace(/^dashboard (view )?/, "") };
  }
  if (kernel === "assistant") return { kind: "assistant", id: "assistant", label: "Iara" };
  if (kernel === "workspace") return { kind: "sql", id: source, label: source };
  if (kernel === "metadata" || kernel === "serving") return null;
  return { kind: "other", id: source, label: source };
}
