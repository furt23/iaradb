"use client";

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useGuard } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { joinPath } from "@/lib/paths";
import { createNotebook } from "@/server/actions/notebooks";

/** A new notebook, in `folder` by default ("" = the workspace root). */
export function NewNotebookDialog({ open, onClose, folder = "notebooks" }: { open: boolean; onClose(): void; folder?: string }) {
  const [name, setName] = useState(joinPath(folder, "untitled.py"));
  useEffect(() => {
    if (open) setName(joinPath(folder, "untitled.py"));
  }, [open, folder]);
  const [busy, setBusy] = useState(false);
  const guard = useGuard();
  const router = useRouter();

  const create = async () => {
    setBusy(true);
    const view = await guard(async () => unwrap(await createNotebook(name)));
    setBusy(false);
    if (view) {
      onClose();
      router.push(`/notebooks/${view.path.split("/").map(encodeURIComponent).join("/")}`);
      router.refresh();
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>New notebook</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          label="Path in the workspace"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
          helperText="A marimo notebook (.py): runnable as a script, readable in Git diffs"
          sx={{ mt: 1 }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={create} disabled={busy || !name.trim()}>
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}
