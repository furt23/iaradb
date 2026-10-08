"use client";

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import { useEffect, useState } from "react";

import { useGuard } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { createCluster, updateCluster, type ClusterInput } from "@/server/actions/clusters";
import type { ClusterView, InstanceType } from "@/server/compute/types";

const DEFAULTS: ClusterInput = { name: "", instanceType: "m7i-flex.large", autoTerminateMinutes: 15, volumeGb: 40 };

function initial(edit: ClusterView | null): ClusterInput {
  if (!edit || edit.kind === "local") return DEFAULTS;
  return {
    name: edit.name,
    instanceType: edit.instanceType?.name ?? DEFAULTS.instanceType,
    autoTerminateMinutes: edit.autoTerminateMinutes ?? DEFAULTS.autoTerminateMinutes,
    volumeGb: edit.volumeGb ?? DEFAULTS.volumeGb,
  };
}

/** Create a cluster, or edit one (its machine only while it is terminated). */
export function ClusterDialog({
  open,
  edit,
  types,
  onClose,
  onSaved,
}: {
  open: boolean;
  edit: ClusterView | null;
  types: InstanceType[];
  onClose(): void;
  onSaved(): void;
}) {
  const [form, setForm] = useState<ClusterInput>(initial(edit));
  const [busy, setBusy] = useState(false);
  const guard = useGuard();
  useEffect(() => {
    if (open) setForm(initial(edit));
  }, [open, edit]);

  const machineLocked = edit !== null && edit.state !== "terminated" && edit.state !== "error";
  const set = <K extends keyof ClusterInput>(k: K, v: ClusterInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true);
    const ok = await guard(async () => {
      if (edit) unwrap(await updateCluster(edit.id, form));
      else unwrap(await createCluster(form));
      return true;
    });
    setBusy(false);
    if (ok) {
      onSaved();
      onClose();
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{edit ? `Edit ${edit.name}` : "Create cluster"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField label="Name" autoFocus value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="analytics" />
          <TextField
            select
            label="Machine"
            value={form.instanceType}
            onChange={(e) => set("instanceType", e.target.value)}
            disabled={machineLocked}
            helperText={machineLocked ? "Terminate the cluster to change its machine" : "Prices are approximate (on-demand, us-east-1)"}
          >
            {types.map((t) => (
              <MenuItem key={t.name} value={t.name}>
                {t.name} · {t.vcpus} vCPU · {t.memoryGib} GiB · {t.family} · ≈${t.usdPerHour.toFixed(2)}/h
              </MenuItem>
            ))}
          </TextField>
          <Stack direction="row" spacing={2}>
            <TextField
              type="number"
              label="Terminate after idle (minutes)"
              value={form.autoTerminateMinutes}
              onChange={(e) => set("autoTerminateMinutes", Number(e.target.value))}
              slotProps={{ htmlInput: { min: 5, max: 1440 } }}
              helperText="No kernel activity for this long ends the machine"
              fullWidth
            />
            <TextField
              type="number"
              label="Disk (GB)"
              value={form.volumeGb}
              onChange={(e) => set("volumeGb", Number(e.target.value))}
              disabled={machineLocked}
              slotProps={{ htmlInput: { min: 20, max: 2000 } }}
              helperText="Scratch space and spill"
              fullWidth
            />
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void save()} disabled={busy || !form.name.trim()}>
          {edit ? "Save" : "Create"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
