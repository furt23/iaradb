"use client";

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useGuard, useNotify } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { isIdentifier } from "@/lib/catalogToml";
import { createSchema } from "@/server/actions/catalog";

/** A new schema: a namespace for tables, declared in workhouse.toml. */
export function NewSchemaDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const guard = useGuard();
  const notify = useNotify();
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
  }, [open]);

  const trimmed = name.trim();
  const badName = trimmed !== "" && !isIdentifier(trimmed);

  const create = async () => {
    if (!trimmed || badName || busy) return;
    setBusy(true);
    const made = await guard(async () => unwrap(await createSchema(trimmed, description)));
    setBusy(false);
    if (made === undefined) return;
    onClose();
    notify(`Created schema ${trimmed}`, "success");
    router.refresh();
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>New schema</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            autoFocus
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
            error={badName}
            helperText={badName ? "Letters, digits and underscores" : "Its tables are named schema.table, e.g. tpch.lineitem"}
          />
          <TextField label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void create()} disabled={busy || !trimmed || badName}>
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}
