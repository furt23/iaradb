"use client";

import ArrowBack from "@mui/icons-material/ArrowBack";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ClusterDialog } from "@/features/compute/ClusterDialog";
import { machineSummary, StateChip } from "@/features/compute/ClusterState";
import { useCompute } from "@/features/compute/ComputeProvider";
import { usePolling } from "@/features/jobs/usePolling";
import { PageBody, PageHeader } from "@/features/shell/PageHeader";
import { clusterDetail } from "@/server/actions/clusters";
import type { ClusterView } from "@/server/compute/types";

import { DetailActions } from "./DetailActions";
import { EventLogTab } from "./EventLogTab";
import { KernelsTab } from "./KernelsTab";
import { NotebooksTab } from "./NotebooksTab";
import { OverviewTab } from "./OverviewTab";
import { useClusterActions } from "./useClusterActions";

type TabId = "overview" | "kernels" | "notebooks" | "events";

/** One cluster: its machine, the kernels on it, the notebooks attached and its event log. */
export function ClusterDetail({ id }: { id: string }) {
  const router = useRouter();
  const { overview, refresh: refreshCompute } = useCompute();
  const { data, error, reload } = usePolling(
    () => clusterDetail(id),
    (d) => d.cluster.state === "starting" || d.cluster.state === "terminating",
  );
  const [tab, setTab] = useState<TabId>("overview");
  const [editing, setEditing] = useState<ClusterView | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const refreshAll = async () => {
    await Promise.all([reload(), refreshCompute()]);
  };
  const actions = useClusterActions(refreshAll, {
    onCloned: (copy) => router.push(`/compute/${encodeURIComponent(copy)}`),
    onDeleted: () => router.push("/compute"),
  });

  if (error && !data) return <Typography sx={{ p: 4, color: "error.main" }}>{error}</Typography>;
  if (!data) return null;
  const { cluster: c, events, kernels, createdAt } = data;

  const title = (
    <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 1.5, minWidth: 0 }}>
      <IconButton component={Link} href="/compute" aria-label="all clusters" size="small">
        <ArrowBack fontSize="small" />
      </IconButton>
      <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {c.name}
      </Box>
      <StateChip cluster={c} />
    </Box>
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <PageHeader
        title={title}
        subtitle={machineSummary(c)}
        actions={<DetailActions cluster={c} cloud={overview?.cloud ?? false} actions={actions} onEdit={() => setEditing(c)} />}
      />
      <PageBody>
        <Tabs value={tab} onChange={(_, v: TabId) => setTab(v)} sx={{ mb: 2, borderBottom: 1, borderColor: "divider" }}>
          <Tab value="overview" label="Overview" />
          <Tab value="kernels" label={`Kernels (${kernels.length})`} />
          <Tab value="notebooks" label={`Notebooks (${c.notebooks.length})`} />
          <Tab value="events" label="Event log" />
        </Tabs>
        {tab === "overview" && <OverviewTab cluster={c} createdAt={createdAt} now={now} kernels={kernels.length} />}
        {tab === "kernels" && <KernelsTab kernels={kernels} now={now} onChanged={refreshAll} />}
        {tab === "notebooks" && <NotebooksTab notebooks={c.notebooks} onChanged={refreshAll} />}
        {tab === "events" && <EventLogTab events={events} now={now} />}
      </PageBody>
      <ClusterDialog
        open={editing !== null}
        edit={editing}
        types={overview?.instanceTypes ?? []}
        onClose={() => setEditing(null)}
        onSaved={() => void refreshAll()}
      />
    </Box>
  );
}
