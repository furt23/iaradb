"use client";

import Add from "@mui/icons-material/Add";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { hourlyCost } from "@/lib/clusterTime";
import { engineStatus } from "@/server/actions/clusters";
import type { ClusterView } from "@/server/compute/types";

import { ClusterDialog } from "./ClusterDialog";
import { ClusterRow, type ClusterActions } from "./ClusterRow";
import { useCompute } from "./ComputeProvider";
import { useClusterActions } from "./detail/useClusterActions";

function EngineNote({ cloud, version }: { cloud: boolean; version: string }) {
  const [wheel, setWheel] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (cloud) void engineStatus().then((r) => setWheel(r.ok ? r.data.wheel : null));
  }, [cloud]);
  if (!cloud) {
    return (
      <Alert severity="info">
        AWS is not configured for this Studio, so only the local cluster is available. Set <code>AWS_ACCESS_KEY_ID</code> /{" "}
        <code>AWS_SECRET_ACCESS_KEY</code> (or <code>IARA_AWS_ENV_FILE</code>) on the server to create clusters.
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
      Engine {version} is not published for clusters yet: run <code>uv run --env-file .aws python -m iara.cloud publish</code>.
    </Alert>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        {label}
      </Typography>
      <Typography variant="h5" sx={{ fontWeight: 700 }}>
        {value}
      </Typography>
    </Paper>
  );
}

/** Running machines, what they cost per hour now, and the notebooks attached to clusters. */
function Summary({ clusters }: { clusters: ClusterView[] }) {
  const { t } = useTranslation();
  const machines = clusters.filter((c) => c.kind === "ec2" && c.state === "running");
  const perHour = machines.reduce((sum, c) => sum + (hourlyCost(c) ?? 0), 0);
  const attached = clusters.reduce((n, c) => n + c.notebooks.length, 0);
  return (
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr 1fr", md: "repeat(3, 1fr)" }, gap: 1.5 }}>
      <Stat label={t("Running")} value={String(machines.length)} />
      <Stat label={t("≈ $/h now")} value={`$${perHour.toFixed(2)}`} />
      <Stat label={t("Notebooks attached")} value={String(attached)} />
    </Box>
  );
}

/** The Compute page: clusters, their machines and lifecycles. */
export function ComputeView() {
  const { t } = useTranslation();
  const { overview, error, refresh } = useCompute();
  const [dialog, setDialog] = useState<{ edit: ClusterView | null } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const clusterActions = useClusterActions(refresh);

  useEffect(() => {
    const tTimer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tTimer);
  }, []);

  const actions: ClusterActions = { ...clusterActions, edit: (c) => setDialog({ edit: c }) };

  return (
    <Box sx={{ p: 3, overflow: "auto", flex: 1 }}>
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 2, mb: 2.5 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>
            {t("Compute")}
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>
            {t("Clusters run the kernels of notebooks, the SQL editor and the catalog, and read your data straight from S3. Notebooks attach to a cluster from their toolbar; many can share one.")}
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<Add />} onClick={() => setDialog({ edit: null })} disabled={!overview?.cloud}>
          {t("Create cluster")}
        </Button>
      </Box>
      <Stack spacing={1.5}>
        {overview && <Summary clusters={overview.clusters} />}
        {error && <Alert severity="error">{error}</Alert>}
        {overview && <EngineNote cloud={overview.cloud} version={overview.engineVersion} />}
        {overview?.clusters.map((c) => <ClusterRow key={c.id} cluster={c} now={now} actions={actions} cloud={overview.cloud} />)}
        {overview && overview.clusters.length === 0 && (
          <Typography sx={{ color: "text.secondary" }}>{t("No clusters yet: create one to run notebooks.")}</Typography>
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
