import type { TaskRun, TaskRunStatus } from "@/lib/jobs";

/** How a task's status reads: a colour of the theme, or muted (not run, or not yet). */
export type StatusTone = "success" | "error" | "warning" | "info" | "muted";

export function statusTone(status: TaskRunStatus): StatusTone {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
    case "upstream_failed":
      return "error";
    case "cancelled":
      return "warning";
    case "starting":
    case "running":
      return "info";
    case "pending":
    case "skipped":
      return "muted";
  }
}

/** The task to show first: one that failed, else one going on, else the first. */
export function firstTask(tasks: TaskRun[]): string | null {
  return (tasks.find((t) => t.status === "failed") ?? tasks.find((t) => t.status === "running" || t.status === "starting") ?? tasks[0])?.key ?? null;
}
