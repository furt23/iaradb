"use client";

import { useEffect, useState } from "react";

import { useNotify } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { attachNotebook, notebookCluster } from "@/server/actions/clusters";

import { ClusterSelect } from "./ClusterSelect";
import { useCompute } from "./ComputeProvider";

/** The notebook toolbar's cluster: where this notebook's kernel runs. `onCluster` tells the editor which one it is. */
export function NotebookClusterSelect({ path, onCluster, onAttached }: { path: string; onCluster(id: string | null): void; onAttached(): void }) {
  const [cluster, setCluster] = useState<string | null>(null);
  const { overview } = useCompute();
  const notify = useNotify();

  useEffect(() => {
    void notebookCluster(path).then((r) => {
      if (!r.ok) return;
      setCluster(r.data.cluster);
      onCluster(r.data.cluster);
    });
  }, [path, onCluster]);

  const attach = async (id: string) => {
    if (id === cluster) return;
    unwrap(await attachNotebook(path, id));
    setCluster(id);
    onCluster(id);
    onAttached();
    const name = overview?.clusters.find((c) => c.id === id)?.name ?? id;
    notify(`Attached to ${name}: the notebook's values were cleared`, "info");
  };

  return <ClusterSelect label="notebook cluster" value={cluster} onSelect={attach} />;
}
