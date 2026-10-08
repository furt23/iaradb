"use client";

import Check from "@mui/icons-material/Check";
import Memory from "@mui/icons-material/Memory";
import PlayArrow from "@mui/icons-material/PlayArrow";
import SettingsOutlined from "@mui/icons-material/SettingsOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { useState } from "react";

import { useGuard } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { startCluster } from "@/server/actions/clusters";
import type { ClusterView } from "@/server/compute/types";

import { useCompute } from "./ComputeProvider";
import { machineSummary, StateDot, stateLabel } from "./ClusterState";

/**
 * The cluster something runs on, as a compact button with its state, a menu
 * to pick another one, and Start when the chosen cluster is not running.
 */
export function ClusterSelect({ value, onSelect, label }: { value: string | null; onSelect(id: string): void | Promise<void>; label: string }) {
  const { overview, refresh } = useCompute();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const guard = useGuard();
  const all = overview?.clusters ?? [];
  const current: ClusterView | undefined = all.find((c) => c.id === value);

  const start = (id: string) =>
    guard(async () => {
      unwrap(await startCluster(id));
      await refresh();
    });
  const choose = (id: string) =>
    guard(async () => {
      setAnchor(null);
      await onSelect(id);
      await refresh();
    });
  const stopped = current && (current.state === "terminated" || current.state === "error");

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, minWidth: 0 }}>
      <Button
        size="small"
        aria-label={label}
        onClick={(e) => setAnchor(e.currentTarget)}
        startIcon={<Memory sx={{ fontSize: 16 }} />}
        endIcon={current ? <StateDot state={current.state} /> : undefined}
        sx={{ color: "text.secondary", textTransform: "none", minWidth: 0, maxWidth: 220 }}
        title={current ? `${current.name}: ${stateLabel(current)}${current.error ? ` (${current.error})` : ""}` : "no cluster"}
      >
        <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {current?.name ?? "No cluster"}
        </Box>
      </Button>
      {stopped && (
        <Button size="small" variant="outlined" startIcon={<PlayArrow />} onClick={() => void start(current.id)}>
          Start
        </Button>
      )}
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)} slotProps={{ list: { dense: true, "aria-label": label } }}>
        {all.map((c) => (
          <MenuItem key={c.id} selected={c.id === value} onClick={() => void choose(c.id)}>
            <ListItemIcon>{c.id === value ? <Check fontSize="small" /> : <StateDot state={c.state} />}</ListItemIcon>
            <ListItemText primary={c.name} secondary={`${stateLabel(c)} · ${machineSummary(c)}`} />
          </MenuItem>
        ))}
        {all.length === 0 && (
          <MenuItem disabled>
            <Typography variant="body2">No clusters yet</Typography>
          </MenuItem>
        )}
        <Divider />
        <MenuItem component={Link} href="/compute" onClick={() => setAnchor(null)}>
          <ListItemIcon>
            <SettingsOutlined fontSize="small" />
          </ListItemIcon>
          Manage clusters…
        </MenuItem>
      </Menu>
    </Box>
  );
}
