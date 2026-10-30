"use client";

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Typography from "@mui/material/Typography";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useNotify } from "@/features/shell/notify";

/** Asks before a measure goes from the model, naming the widgets that draw it (they stop drawing it). */
export function DeleteMeasureDialog({ name, usedBy, onConfirm, onClose }: { name: string | null; usedBy: string[]; onConfirm(): Promise<void>; onClose(): void }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={name !== null} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{t("Delete measure?")}</DialogTitle>
      <DialogContent>
        <Typography sx={{ fontFamily: "var(--font-mono, monospace)", fontSize: 13, overflowWrap: "anywhere" }}>{name}</Typography>
        {usedBy.length > 0 && <Typography sx={{ fontSize: 13, color: "text.secondary", mt: 1 }}>{t("Used by: {{widgets}}", { widgets: usedBy.join(", ") })}</Typography>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {t("Cancel")}
        </Button>
        <Button color="error" variant="contained" disabled={busy} onClick={() => void confirm()}>
          {t("Delete")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
