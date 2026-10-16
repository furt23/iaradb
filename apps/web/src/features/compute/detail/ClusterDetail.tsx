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
import { useTranslation } from "react-i18next";

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
import { LibrariesTab } from "./LibrariesTab";
import { LogsTab } from "./LogsTab";
import { NotebooksTab } from "./NotebooksTab";
import { OverviewTab } from "./OverviewTab";
import { useClusterActions } from "./useClusterActions";

type TabId = "overview" | "kernels" | "notebooks" | "libraries" | "logs" | "events";

/** One cluster: its machine, kernels, notebooks, libraries, logs and event log. */
export function ClusterDetail({ id }: { id: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const { overview, refresh: refreshCompute } = useCompute();
  const { data, error, reload } = usePolling(
    () => clusterDetail(id),
    (d) =>
      d.cluster.state === "starting" ||
      d.cluster.state === "terminating" ||
      Object.values(d.cluster.libraryStatus ?? {}).some((s) => s.state === "installing"),
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
          <Tab value="overview" label={t("Overview")} />
          <Tab value="kernels" label={t("Kernels ({{n}})", { n: kernels.length })} />
          <Tab value="notebooks" label={t("Notebooks ({{n}})", { n: c.notebooks.length })} />
          {c.kind === "ec2" && <Tab value="libraries" label={t("Libraries ({{n}})", { n: c.libraries?.length ?? 0 })} />}
          <Tab value="logs" label={t("Logs")} />
          <Tab value="events" label={t("Event log")} />
        </Tabs>
        {tab === "overview" && <OverviewTab cluster={c} createdAt={createdAt} now={now} kernels={kernels.length} />}
        {tab === "kernels" && <KernelsTab kernels={kernels} now={now} onChanged={refreshAll} />}
        {tab === "notebooks" && <NotebooksTab clusterId={c.id} notebooks={c.notebooks} canAttach={!c.job} onChanged={refreshAll} />}
        {tab === "libraries" && c.kind === "ec2" && <LibrariesTab cluster={c} onChanged={refreshAll} />}
        {tab === "logs" && <LogsTab cluster={c} />}
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
