"use client";

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useGuard, useNotify } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { addTable } from "@/server/actions/catalog";

export function AddTableDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [format, setFormat] = useState<"auto" | "parquet" | "csv">("auto");
  const guard = useGuard();
  const notify = useNotify();
  const router = useRouter();

  const submit = () =>
    guard(async () => {
      unwrap(await addTable(name, path, format === "auto" ? undefined : format));
      notify(`Added ${name} to workhouse.toml`, "success");
      onClose();
      router.refresh();
    });

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Add a table</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus helperText="Letters, digits and underscores" />
          <TextField label="Path" value={path} onChange={(e) => setPath(e.target.value)} helperText="Relative to the workspace: a file, a directory or a glob (data/events/*.parquet)" />
          <TextField select label="Format" value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
            <MenuItem value="auto">From the extension</MenuItem>
            <MenuItem value="parquet">Parquet</MenuItem>
            <MenuItem value="csv">CSV</MenuItem>
          </TextField>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={submit} disabled={!name || !path}>
          Add
        </Button>
      </DialogActions>
    </Dialog>
  );
}
