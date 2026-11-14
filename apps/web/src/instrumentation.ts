/** Runs once when the Studio's server starts: scheduled jobs start running, and the `system` catalog is published. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.IARA_SCHEDULER === "0") return;
  const { startScheduler } = await import("./server/jobs/scheduler");
  startScheduler();
  const { startPublisher } = await import("./server/system/publisher");
  startPublisher();
}
