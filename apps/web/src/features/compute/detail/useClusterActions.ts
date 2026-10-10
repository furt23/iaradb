"use client";

import { useGuard, useNotify } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { cloneCluster, deleteCluster, startCluster, terminateCluster } from "@/server/actions/clusters";
import type { ClusterView } from "@/server/compute/types";

export interface ClusterActionHooks {
  /** a copy was made (its id) */
  onCloned?(id: string): void;
  onDeleted?(): void;
}

/** Start, terminate, clone and delete a cluster; `refresh` reloads the page's data after each. */
export function useClusterActions(refresh: () => Promise<unknown>, hooks: ClusterActionHooks = {}) {
  const guard = useGuard();
  const notify = useNotify();
  const run = (task: () => Promise<void>, done: string) =>
    void guard(async () => {
      await task();
      notify(done, "success");
      await refresh();
    });
  return {
    start: (c: ClusterView) =>
      run(async () => void unwrap(await startCluster(c.id)), `Starting ${c.name}: a machine is on its way (2-3 minutes)`),
    terminate: (c: ClusterView) => run(async () => void unwrap(await terminateCluster(c.id)), `Terminating ${c.name}`),
    clone: (c: ClusterView) => run(async () => hooks.onCloned?.(unwrap(await cloneCluster(c.id)).id), `Cloned ${c.name}`),
    remove: (c: ClusterView) =>
      run(async () => {
        unwrap(await deleteCluster(c.id));
        hooks.onDeleted?.();
      }, `Deleted ${c.name}`),
  };
}
