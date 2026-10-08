"use client";

import { useEffect, useState } from "react";

import { useNotify } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { attachNotebook, notebookCluster } from "@/server/actions/clusters";

import { ClusterSelect } from "./ClusterSelect";
import { useCompute } from "./ComputeProvider";

/** The notebook toolbar's cluster: where this notebook's kernel runs. */
export function NotebookClusterSelect({ path, onAttached }: { path: string; onAttached(): void }) {
  const [cluster, setCluster] = useState<string | null>(null);
  const { overview } = useCompute();
  const notify = useNotify();

  useEffect(() => {
    void notebookCluster(path).then((r) => r.ok && setCluster(r.data.cluster));
  }, [path]);

  const attach = async (id: string) => {
    if (id === cluster) return;
    unwrap(await attachNotebook(path, id));
    setCluster(id);
    onAttached();
    const name = overview?.clusters.find((c) => c.id === id)?.name ?? id;
    notify(`Attached to ${name}: the notebook's values were cleared`, "info");
  };

  return <ClusterSelect label="notebook cluster" value={cluster} onSelect={attach} />;
}
