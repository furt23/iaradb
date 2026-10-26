"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormHelperText from "@mui/material/FormHelperText";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useGuard } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { createCluster, updateCluster, type ClusterInput } from "@/server/actions/clusters";
import type { ClusterView, InstanceType } from "@/server/compute/types";

import { KeyValueEditor } from "./dialog/KeyValueEditor";
import { LibrariesEditor } from "./dialog/LibrariesEditor";

const DEFAULTS: ClusterInput = {
  name: "",
  instanceType: "m7i-flex.large",
  autoTerminateMinutes: 15,
  volumeGb: 40,
  libraries: [],
  env: {},
  initScript: "",
  spot: false,
  maxHours: 1,
  tags: {},
};

/** The init script's size limit, in bytes. */
const INIT_SCRIPT_MAX_BYTES = 8 * 1024;

function initial(edit: ClusterView | null): ClusterInput {
  if (!edit || edit.kind === "local") return DEFAULTS;
  return {
    name: edit.name,
    instanceType: edit.instanceType?.name ?? DEFAULTS.instanceType,
    autoTerminateMinutes: edit.autoTerminateMinutes ?? DEFAULTS.autoTerminateMinutes,
    volumeGb: edit.volumeGb ?? DEFAULTS.volumeGb,
    libraries: edit.libraries ?? DEFAULTS.libraries,
    env: edit.env ?? DEFAULTS.env,
    initScript: edit.initScript ?? DEFAULTS.initScript,
    spot: edit.spot ?? DEFAULTS.spot,
    maxHours: edit.maxHours ?? DEFAULTS.maxHours,
    tags: edit.tags ?? DEFAULTS.tags,
  };
}

type TabId = "general" | "libraries" | "environment" | "tags";

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
  const { t } = useTranslation();
  const [form, setForm] = useState<ClusterInput>(initial(edit));
  const [tab, setTab] = useState<TabId>("general");
  const [busy, setBusy] = useState(false);
  const [startNow, setStartNow] = useState(true);
  const guard = useGuard();
  useEffect(() => {
    if (open) {
      setForm(initial(edit));
      setTab("general");
      setStartNow(true);
    }
  }, [open, edit]);

  const machineLocked = edit !== null && edit.state !== "terminated" && edit.state !== "error";
  const set = <K extends keyof ClusterInput>(k: K, v: ClusterInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const initTooBig = new TextEncoder().encode(form.initScript).length > INIT_SCRIPT_MAX_BYTES;
  const lockedHelper = t("Terminate the cluster to change this");

  const save = async () => {
    setBusy(true);
    // a new cluster starts right away when asked to; an edit never starts it
    const ok = await guard(async () => {
      if (edit) unwrap(await updateCluster(edit.id, form));
      else unwrap(await createCluster(form, startNow));
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
      <DialogTitle>{edit ? `${t("Edit")} ${edit.name}` : t("Create cluster")}</DialogTitle>
      <DialogContent sx={{ minHeight: 440 }}>
        <Tabs value={tab} onChange={(_, v: TabId) => setTab(v)} sx={{ mb: 2.5, borderBottom: 1, borderColor: "divider" }}>
          <Tab label={t("General")} value="general" />
          <Tab label={t("Libraries")} value="libraries" />
          <Tab label={t("Environment")} value="environment" />
          <Tab label={t("Tags")} value="tags" />
        </Tabs>

        {tab === "general" && (
          <Stack spacing={2.5}>
            <TextField label={t("Name")} autoFocus value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="analytics" />
            <TextField
              select
              label={t("Machine")}
              value={form.instanceType}
              onChange={(e) => set("instanceType", e.target.value)}
              disabled={machineLocked}
              helperText={machineLocked ? t("Terminate the cluster to change its machine") : undefined}
            >
              {types.map((type) => (
                <MenuItem key={type.name} value={type.name}>
                  {type.name} · {type.vcpus} vCPU · {type.memoryGib} GiB · {type.family}
                </MenuItem>
              ))}
            </TextField>
            <Box>
              <FormControlLabel
                control={<Switch checked={form.spot} disabled={machineLocked} onChange={(e) => set("spot", e.target.checked)} />}
                label={t("Spot machine")}
              />
              <FormHelperText sx={{ mt: 0 }}>
                {machineLocked
                  ? lockedHelper
                  : t("AWS can reclaim the machine with 2 minutes' notice.")}
              </FormHelperText>
            </Box>
            <Stack direction="row" spacing={2}>
              <TextField
                type="number"
                label={t("Terminate after idle (minutes)")}
                value={form.autoTerminateMinutes}
                onChange={(e) => set("autoTerminateMinutes", Number(e.target.value))}
                slotProps={{ htmlInput: { min: 5, max: 1440 } }}
                fullWidth
              />
              <TextField
                type="number"
                label={t("Disk (GB)")}
                value={form.volumeGb}
                onChange={(e) => set("volumeGb", Number(e.target.value))}
                disabled={machineLocked}
                slotProps={{ htmlInput: { min: 20, max: 2000 } }}
                helperText={machineLocked ? lockedHelper : undefined}
                fullWidth
              />
            </Stack>
            <TextField
              type="number"
              label={t("Time limit (hours)")}
              value={form.maxHours}
              onChange={(e) => set("maxHours", Number(e.target.value))}
              slotProps={{ htmlInput: { min: 1, max: 12 } }}
              helperText={t("Terminates the machine even when busy.")}
            />
          </Stack>
        )}

        {tab === "libraries" && <LibrariesEditor value={form.libraries} onChange={(v) => set("libraries", v)} />}

        {tab === "environment" && (
          <Stack spacing={3}>
            <KeyValueEditor
              label={t("Environment variables")}
              keyLabel={t("Name")}
              valueLabel={t("Value")}
              value={form.env}
              onChange={(v) => set("env", v)}
              helperText={t("Not for secrets: they are visible on the machine.")}
            />
            <TextField
              label={t("Init script")}
              multiline
              minRows={6}
              value={form.initScript}
              onChange={(e) => set("initScript", e.target.value)}
              disabled={machineLocked}
              placeholder="#!/bin/bash"
              error={initTooBig}
              helperText={
                machineLocked
                  ? lockedHelper
                  : initTooBig
                    ? t("The init script is over 8 KB")
                    : t("Runs as root at boot. A failure stops the start. Max 8 KB.")
              }
              sx={{ "& .MuiInputBase-input": { fontFamily: "monospace" } }}
            />
          </Stack>
        )}

        {tab === "tags" && (
          <KeyValueEditor
            label={t("AWS tags")}
            keyLabel={t("Key")}
            valueLabel={t("Value")}
            value={form.tags}
            onChange={(v) => set("tags", v)}
            disabled={machineLocked}
            helperText={machineLocked ? lockedHelper : undefined}
          />
        )}
      </DialogContent>
      <DialogActions>
        {!edit && (
          <FormControlLabel
            sx={{ flex: 1, ml: 1.5 }}
            control={<Checkbox checked={startNow} onChange={(e) => setStartNow(e.target.checked)} disabled={busy} />}
            label={t("Start the cluster now")}
          />
        )}
        <Button onClick={onClose} disabled={busy}>
          {t("Cancel")}
        </Button>
        <Button variant="contained" onClick={() => void save()} disabled={busy || !form.name.trim() || initTooBig}>
          {edit ? t("Save") : t("Create")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
