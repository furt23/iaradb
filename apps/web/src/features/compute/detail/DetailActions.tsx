"use client";

import ContentCopyOutlined from "@mui/icons-material/ContentCopyOutlined";
import DeleteOutline from "@mui/icons-material/DeleteOutlineOutlined";
import EditOutlined from "@mui/icons-material/EditOutlined";
import PlayArrow from "@mui/icons-material/PlayArrow";
import StopOutlined from "@mui/icons-material/StopOutlined";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";

import type { ClusterView } from "@/server/compute/types";

import type { ClusterActions } from "../ClusterRow";

/** The header actions of an EC2 cluster (the local one has none). */
export function DetailActions({
  cluster: c,
  cloud,
  actions,
  onEdit,
}: {
  cluster: ClusterView;
  cloud: boolean;
  actions: Pick<ClusterActions, "start" | "terminate" | "clone" | "remove">;
  onEdit(): void;
}) {
  if (c.kind !== "ec2") return null;
  const stopped = c.state === "terminated" || c.state === "error";
  return (
    <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
      {stopped ? (
        <Button variant="contained" startIcon={<PlayArrow />} onClick={() => actions.start(c)} disabled={!cloud}>
          Start
        </Button>
      ) : (
        <Button variant="outlined" color="error" startIcon={<StopOutlined />} onClick={() => actions.terminate(c)} disabled={c.state === "terminating"}>
          Terminate
        </Button>
      )}
      <Button variant="outlined" startIcon={<EditOutlined />} onClick={onEdit}>
        Edit
      </Button>
      <Button variant="outlined" startIcon={<ContentCopyOutlined />} onClick={() => actions.clone(c)}>
        Clone
      </Button>
      {stopped && (
        <Tooltip title="Delete">
          <IconButton onClick={() => actions.remove(c)} aria-label={`delete ${c.name}`}>
            <DeleteOutline />
          </IconButton>
        </Tooltip>
      )}
    </Stack>
  );
}
