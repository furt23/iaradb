"use client";

import PlayArrow from "@mui/icons-material/PlayArrow";
import StopOutlined from "@mui/icons-material/StopOutlined";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useState } from "react";

import type { ClusterView } from "@/server/compute/types";

import { useClusterActions } from "./useClusterActions";

/** Start a stopped cluster: its machine is on its way in 2-3 minutes. */
export function StartClusterButton({ cluster, disabled = false }: { cluster: ClusterView; disabled?: boolean }) {
  const { start } = useClusterActions();
  return (
    <Button size="small" variant="outlined" startIcon={<PlayArrow />} onClick={() => void start(cluster.id)} disabled={disabled}>
      Start
    </Button>
  );
}

/** Terminate a running cluster, after an inline "Terminate? Yes / No" (no browser dialog). */
export function TerminateClusterButton({ cluster }: { cluster: ClusterView }) {
  const { terminate } = useClusterActions();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!asking) {
    return (
      <Button size="small" variant="outlined" color="error" startIcon={<StopOutlined />} onClick={() => setAsking(true)}>
        Terminate
      </Button>
    );
  }

  const confirm = async () => {
    setBusy(true);
    await terminate(cluster.id);
    setBusy(false);
    setAsking(false);
  };

  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
      <Typography variant="body2">Terminate?</Typography>
      <Button size="small" variant="contained" color="error" onClick={() => void confirm()} disabled={busy}>
        Yes
      </Button>
      <Button size="small" onClick={() => setAsking(false)} disabled={busy}>
        No
      </Button>
    </Stack>
  );
}
