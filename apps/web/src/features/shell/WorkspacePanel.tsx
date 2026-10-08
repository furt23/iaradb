"use client";

import Add from "@mui/icons-material/Add";
import CreateNewFolderOutlined from "@mui/icons-material/CreateNewFolderOutlined";
import Refresh from "@mui/icons-material/Refresh";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { FileTree } from "@/features/files/FileTree";
import { NewFolderDialog } from "@/features/files/NewFolderDialog";
import { NewNotebookDialog } from "@/features/files/NewNotebookDialog";
import type { FileNode } from "@/server/workspace/files";

import { DefaultClusterChip } from "@/features/compute/DefaultClusterChip";

/** The side panel: workspace name, actions and file tree. */
export function WorkspacePanel({ name, tree }: { name: string; tree: FileNode[] }) {
  const [creating, setCreating] = useState(false);
  const [folder, setFolder] = useState(false);
  const router = useRouter();
  return (
    <Box
      component="aside"
      sx={{ width: 260, flexShrink: 0, display: "flex", flexDirection: "column", borderRight: 1, borderColor: "divider", bgcolor: "background.paper" }}
    >
      <Box sx={{ display: "flex", alignItems: "center", px: 1.5, height: 48, gap: 0.5, borderBottom: 1, borderColor: "divider" }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="overline" sx={{ color: "text.disabled", lineHeight: 1.2, display: "block", fontSize: 10 }}>
            Workspace
          </Typography>
          <Typography noWrap sx={{ fontWeight: 650, fontSize: 14 }}>
            {name}
          </Typography>
        </Box>
        <Tooltip title="New notebook">
          <IconButton onClick={() => setCreating(true)} aria-label="new notebook">
            <Add fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="New folder">
          <IconButton onClick={() => setFolder(true)} aria-label="new folder">
            <CreateNewFolderOutlined fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Refresh files">
          <IconButton onClick={() => router.refresh()} aria-label="refresh files">
            <Refresh fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
      <DefaultClusterChip />
      <Box sx={{ flex: 1, overflow: "auto", px: 0.5 }}>
        <FileTree nodes={tree} />
      </Box>
      <NewNotebookDialog open={creating} onClose={() => setCreating(false)} />
      <NewFolderDialog parent={folder ? "" : null} onClose={() => setFolder(false)} />
    </Box>
  );
}
