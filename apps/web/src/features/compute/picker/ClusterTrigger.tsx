"use client";

import ArrowDropDown from "@mui/icons-material/ArrowDropDown";
import Memory from "@mui/icons-material/Memory";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";

import type { ClusterView } from "@/server/compute/types";

import { StateDot, stateLabel } from "../ClusterState";

/** The picker's button: the chosen cluster's name and state, with a dropdown arrow. */
export function ClusterTrigger({
  label,
  current,
  loaded,
  open,
  onOpen,
}: {
  label: string;
  current: ClusterView | undefined;
  loaded: boolean;
  open: boolean;
  onOpen(anchor: HTMLElement): void;
}) {
  return (
    <Button
      variant="outlined"
      size="small"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open || undefined}
      onClick={(e) => onOpen(e.currentTarget)}
      startIcon={<Memory sx={{ fontSize: 16 }} />}
      endIcon={<ArrowDropDown />}
      title={current ? `${current.name}: ${stateLabel(current)}${current.error ? ` (${current.error})` : ""}` : "no cluster"}
      sx={{ color: "text.secondary", borderColor: "divider", textTransform: "none", minWidth: 0, maxWidth: 260 }}
    >
      <Box component="span" sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
        <Box component="span" sx={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {current?.name ?? (loaded ? "No cluster" : "…")}
        </Box>
        {current && <StateDot state={current.state} />}
      </Box>
    </Button>
  );
}
