"use client";

import Add from "@mui/icons-material/Add";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useEffect, useState } from "react";

import { useGuard, useNotify } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { deleteCluster, engineStatus, startCluster, terminateCluster } from "@/server/actions/clusters";
import type { ClusterView } from "@/server/compute/types";

import { ClusterDialog } from "./ClusterDialog";
import { ClusterRow, type ClusterActions } from "./ClusterRow";
import { useCompute } from "./ComputeProvider";

function EngineNote({ cloud, version }: { cloud: boolean; version: string }) {
  const [wheel, setWheel] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (cloud) void engineStatus().then((r) => setWheel(r.ok ? r.data.wheel : null));
  }, [cloud]);
  if (!cloud) {
    return (
      <Alert severity="info">
        AWS is not configured for this Studio, so only the local cluster is available. Set <code>AWS_ACCESS_KEY_ID</code> /{" "}
        <code>AWS_SECRET_ACCESS_KEY</code> (or <code>WORKHOUSE_AWS_ENV_FILE</code>) on the server to create clusters.
      </Alert>
    );
  }
  if (wheel === undefined) return null;
  return wheel ? (
    <Alert severity="success" variant="outlined">
      Clusters install engine {version} ({wheel.slice(wheel.lastIndexOf("/") + 1)}).
    </Alert>
  ) : (
    <Alert severity="warning">
      Engine {version} is not published for clusters yet: run <code>uv run --env-file .aws python -m workhouse.cloud publish</code>.
    </Alert>
  );
}

/** The Compute page: clusters, their machines and lifecycles. */
export function ComputeView() {
  const { overview, error, refresh } = useCompute();
  const [dialog, setDialog] = useState<{ edit: ClusterView | null } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const guard = useGuard();
  const notify = useNotify();

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const act = (fn: () => Promise<unknown>, done: string) =>
    void guard(async () => {
      await fn();
      notify(done, "success");
      await refresh();
    });
  const actions: ClusterActions = {
    start: (c) => act(async () => unwrap(await startCluster(c.id)), `Starting ${c.name}: a machine is on its way (2-3 minutes)`),
    terminate: (c) => act(async () => unwrap(await terminateCluster(c.id)), `Terminating ${c.name}`),
    edit: (c) => setDialog({ edit: c }),
    remove: (c) => act(async () => unwrap(await deleteCluster(c.id)), `Deleted ${c.name}`),
  };

  return (
    <Box sx={{ p: 3, overflow: "auto", flex: 1 }}>
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 2, mb: 2.5 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>
            Compute
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>
            Clusters run the kernels of notebooks, the SQL editor and the catalog, and read your data straight from S3. Notebooks attach to a
            cluster from their toolbar; many can share one.
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<Add />} onClick={() => setDialog({ edit: null })} disabled={!overview?.cloud}>
          Create cluster
        </Button>
      </Box>
      <Stack spacing={1.5}>
        {error && <Alert severity="error">{error}</Alert>}
        {overview && <EngineNote cloud={overview.cloud} version={overview.engineVersion} />}
        {overview?.clusters.map((c) => <ClusterRow key={c.id} cluster={c} now={now} actions={actions} cloud={overview.cloud} />)}
        {overview && overview.clusters.length === 0 && (
          <Typography sx={{ color: "text.secondary" }}>No clusters yet: create one to run notebooks.</Typography>
        )}
      </Stack>
      <ClusterDialog
        open={dialog !== null}
        edit={dialog?.edit ?? null}
        types={overview?.instanceTypes ?? []}
        onClose={() => setDialog(null)}
        onSaved={() => void refresh()}
      />
    </Box>
  );
}
