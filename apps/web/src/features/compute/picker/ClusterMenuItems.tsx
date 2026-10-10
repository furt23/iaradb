"use client";

import Check from "@mui/icons-material/Check";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import ListSubheader from "@mui/material/ListSubheader";
import MenuItem from "@mui/material/MenuItem";
import Typography from "@mui/material/Typography";

import { groupClusters, notebooksLabel } from "@/lib/clusterPicker";
import type { ClusterView } from "@/server/compute/types";

import { machineSummary, StateDot } from "../ClusterState";

/** The clusters, grouped as Running and Stopped. Picking one attaches to it. */
export function ClusterMenuItems({
  clusters,
  query,
  value,
  emptyText,
  onChoose,
}: {
  clusters: ClusterView[];
  query: string;
  value: string | null;
  emptyText: string;
  onChoose(id: string): void;
}) {
  const { running, stopped } = groupClusters(clusters, query);
  if (running.length + stopped.length === 0) {
    return (
      <MenuItem disabled>
        <Typography variant="body2">{emptyText}</Typography>
      </MenuItem>
    );
  }
  return (
    <>
      <ClusterGroup title="Running" clusters={running} value={value} onChoose={onChoose} />
      <ClusterGroup title="Stopped" clusters={stopped} value={value} onChoose={onChoose} />
    </>
  );
}

function ClusterGroup({ title, clusters, value, onChoose }: { title: string; clusters: ClusterView[]; value: string | null; onChoose(id: string): void }) {
  if (clusters.length === 0) return null;
  return (
    <>
      <ListSubheader sx={{ lineHeight: "32px" }}>{title}</ListSubheader>
      {clusters.map((c) => (
        <ClusterItem key={c.id} cluster={c} selected={c.id === value} onChoose={onChoose} />
      ))}
    </>
  );
}

function ClusterItem({ cluster: c, selected, onChoose }: { cluster: ClusterView; selected: boolean; onChoose(id: string): void }) {
  return (
    <MenuItem selected={selected} onClick={() => onChoose(c.id)}>
      <ListItemIcon>{selected ? <Check fontSize="small" /> : <StateDot state={c.state} />}</ListItemIcon>
      <ListItemText
        primary={
          <Box component="span" sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>
            <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {c.name}
            </Box>
            {c.isDefault && <Chip component="span" size="small" variant="outlined" label="default" />}
          </Box>
        }
        secondary={`${machineSummary(c)} · ${notebooksLabel(c.notebooks.length)}`}
      />
    </MenuItem>
  );
}
