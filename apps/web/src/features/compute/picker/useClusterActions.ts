import { useGuard } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { startCluster, terminateCluster } from "@/server/actions/clusters";

import { useCompute } from "../ComputeProvider";

/** Start or terminate a cluster from the picker, then refresh the clusters. */
export function useClusterActions() {
  const { refresh } = useCompute();
  const guard = useGuard();
  const start = (id: string) =>
    guard(async () => {
      unwrap(await startCluster(id));
      await refresh();
    });
  const terminate = (id: string) =>
    guard(async () => {
      unwrap(await terminateCluster(id));
      await refresh();
    });
  return { start, terminate };
}
