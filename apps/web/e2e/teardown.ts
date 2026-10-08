import fs from "node:fs";

/** Remove the throwaway workspace (best effort: Windows may still hold files). */
export default function teardown(): void {
  const dir = process.env.WORKHOUSE_E2E_WORKSPACE;
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // left in the temp directory
  }
}
