/**
 * Whether the Studio offers the "Local" cluster, which runs kernels on the
 * Studio's own machine (pure; unit tested). Only development does by default:
 * a hosted Studio keeps its secrets and its data directory on that machine, so
 * it runs kernels on clusters. `IARA_LOCAL_COMPUTE` overrides either way.
 */
export function localComputeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const flag = env.IARA_LOCAL_COMPUTE?.trim().toLowerCase();
  if (flag) return ["1", "true", "yes", "on"].includes(flag);
  return env.NODE_ENV !== "production";
}
