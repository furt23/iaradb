/** Runs once when the Studio's server starts: scheduled jobs start running. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.WORKHOUSE_SCHEDULER === "0") return;
  const { startScheduler } = await import("./server/jobs/scheduler");
  startScheduler();
}
