"use client";

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { DashboardConfig } from "@/lib/dashboards/types";

function SettingsForm({ config, onSave, onClose }: { config: DashboardConfig; onSave(config: DashboardConfig): void; onClose(): void }) {
  const { t } = useTranslation();
  const [description, setDescription] = useState(config.description ?? "");
  const [minutes, setMinutes] = useState(String(config.refresh_minutes));
  const refresh = Number(minutes);
  const valid = Number.isInteger(refresh) && refresh >= 1 && refresh <= 1440;

  return (
    <>
      <DialogTitle>{t("Dashboard settings")}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField label={t("Description")} value={description} onChange={(e) => setDescription(e.target.value)} multiline minRows={2} fullWidth />
          <TextField
            label={t("Refresh data every (minutes)")}
            type="number"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            error={!valid}
            helperText={t("From 1 to 1440.")}
            slotProps={{ htmlInput: { min: 1, max: 1440 } }}
            fullWidth
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("Cancel")}</Button>
        <Button
          variant="contained"
          disabled={!valid}
          onClick={() => {
            onSave({ ...config, description: description.trim() || undefined, refresh_minutes: refresh });
            onClose();
          }}
        >
          {t("Save")}
        </Button>
      </DialogActions>
    </>
  );
}

/** The dashboard's description and how long viewers' data is reused. */
export function SettingsDialog({ open, config, onSave, onClose }: { open: boolean; config: DashboardConfig; onSave(config: DashboardConfig): void; onClose(): void }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <SettingsForm config={config} onSave={onSave} onClose={onClose} />
    </Dialog>
  );
}
