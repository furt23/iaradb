"use client";

import Box from "@mui/material/Box";
import ListSubheader from "@mui/material/ListSubheader";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { canTerminate, isStopped, runtimeSummary } from "@/lib/clusterPicker";
import type { ClusterView } from "@/server/compute/types";

import { machineSummary, StateChip } from "../ClusterState";
import { StartClusterButton, TerminateClusterButton } from "./ClusterActionButtons";
import { useNow } from "./useNow";

/** The top of the picker: the chosen cluster, its machine, uptime and cost, with Start or Terminate. */
export function CurrentClusterCard({ cluster: c, cloud }: { cluster: ClusterView; cloud: boolean }) {
  const now = useNow(30_000);
  const runtime = runtimeSummary(c, now);
  return (
    <ListSubheader
      component="div"
      role="presentation"
      disableSticky
      sx={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 0.5, py: 1.5, px: 2, lineHeight: "normal", color: "text.primary", bgcolor: "action.hover" }}
    >
      <Typography variant="overline" sx={{ color: "text.secondary", lineHeight: 1.5 }}>
        Current
      </Typography>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, maxWidth: "100%", minWidth: 0 }}>
        <Typography component="div" sx={{ fontWeight: 650, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {c.name}
        </Typography>
        <StateChip cluster={c} />
      </Box>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        {machineSummary(c)}
      </Typography>
      {runtime && (
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {runtime}
        </Typography>
      )}
      {c.error && (
        <Typography variant="caption" sx={{ color: "error.main", overflowWrap: "anywhere" }}>
          {c.error}
        </Typography>
      )}
      {(isStopped(c) || canTerminate(c)) && (
        <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
          {isStopped(c) && <StartClusterButton cluster={c} disabled={!cloud} />}
          {canTerminate(c) && <TerminateClusterButton cluster={c} />}
        </Stack>
      )}
    </ListSubheader>
  );
}
