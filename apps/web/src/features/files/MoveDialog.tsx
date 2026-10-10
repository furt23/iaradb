"use client";

import FolderOutlined from "@mui/icons-material/FolderOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useGuard, useNotify } from "@/features/shell/notify";
import { useWorkbench } from "@/features/workbench/WorkbenchProvider";
import { unwrap } from "@/lib/action";
import { baseName, joinPath } from "@/lib/paths";
import { renameEntry } from "@/server/actions/files";
import { workspaceTree } from "@/server/actions/workspace";
import type { FileNode } from "@/server/workspace/files";

import { moveTargets } from "./moveTargets";

/** Pick a folder of the workspace and move `path` into it (its name stays). */
export function MoveDialog({ path, onClose }: { path: string | null; onClose(): void }) {
  const [tree, setTree] = useState<FileNode[] | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const guard = useGuard();
  const notify = useNotify();
  const router = useRouter();
  const { act } = useWorkbench();

  // the folders are read when the dialog opens (they may have changed)
  useEffect(() => {
    setTarget(null);
    setTree(null);
    if (path === null) return;
    void workspaceTree().then((r) => {
      if (!r.ok) notify(r.error.message, "error");
      setTree(r.ok ? r.data : []);
    });
  }, [path, notify]);

  const options = tree && path !== null ? moveTargets(tree, path) : null;

  const move = async () => {
    if (path === null || target === null || busy) return;
    setBusy(true);
    const moved = await guard(async () => unwrap(await renameEntry(path, joinPath(target, baseName(path)))));
    setBusy(false);
    if (!moved) return;
    onClose();
    act({ type: "rename", from: moved.from, to: moved.to });
    notify(`Moved to ${moved.to}`, "success");
    router.refresh();
  };

  return (
    <Dialog open={path !== null} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>Move to…</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ overflowWrap: "anywhere" }}>
          Move <Box component="strong">{baseName(path ?? "")}</Box> into:
        </DialogContentText>
        {options === null ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
            <CircularProgress size={22} />
          </Box>
        ) : (
          <List dense aria-label="folders" sx={{ mt: 1, maxHeight: 320, overflow: "auto", border: 1, borderColor: "divider", borderRadius: 1 }}>
            {options.map((folder) => (
              <ListItemButton key={folder || "/"} selected={target === folder} onClick={() => setTarget(folder)}>
                <ListItemIcon sx={{ minWidth: 32 }}>
                  <FolderOutlined fontSize="small" />
                </ListItemIcon>
                <ListItemText primary={folder || "/"} slotProps={{ primary: { noWrap: true, sx: { fontSize: 14 } } }} />
              </ListItemButton>
            ))}
          </List>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void move()} disabled={busy || target === null}>
          Move
        </Button>
      </DialogActions>
    </Dialog>
  );
}
