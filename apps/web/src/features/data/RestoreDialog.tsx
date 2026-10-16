"use client";

import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import { useState } from "react";
import { useTranslation } from "react-i18next";

/** Confirm a restore; the statement's error (the engine may not support it) stays in the dialog. */
export function RestoreDialog({ table, version, onRestore, onClose }: { table: string; version: number | null; onRestore(version: number): Promise<void>; onClose(): void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (busy) return;
    setError(null);
    onClose();
  };
  const restore = async () => {
    if (version === null) return;
    setBusy(true);
    setError(null);
    try {
      await onRestore(version);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={version !== null} onClose={close} maxWidth="xs" fullWidth>
      <DialogTitle>
        {t("Restore {{table}} to version {{version}}?", { table, version })}
      </DialogTitle>
      <DialogContent>
        <DialogContentText>
          {t("The table gets a new version with the contents of version {{version}}. Earlier versions stay in the history until they are vacuumed.", { version })}
        </DialogContentText>
        {error && (
          <Alert severity="error" sx={{ mt: 2, whiteSpace: "pre-wrap" }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={busy}>
          {t("Cancel")}
        </Button>
        <Button variant="contained" onClick={() => void restore()} disabled={busy}>
          {t("Restore")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

