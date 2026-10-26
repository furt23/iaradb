"use client";

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { createDashboardAction } from "@/server/actions/dashboards";

function NewDashboardForm({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = title.trim() !== "" && !busy;

  const create = async () => {
    if (!ready) return;
    setBusy(true);
    const r = await createDashboardAction(title.trim());
    if (r.ok) router.push(`/dashboards/${r.data.slug}`);
    else {
      setError(r.error.message);
      setBusy(false);
    }
  };

  return (
    <>
      <DialogTitle>{t("New dashboard")}</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          margin="dense"
          label={t("Title")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void create()}
          error={error !== null}
          helperText={error}
          slotProps={{ htmlInput: { maxLength: 120 } }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("Cancel")}</Button>
        <Button variant="contained" disabled={!ready} onClick={() => void create()}>
          {t("Create")}
        </Button>
      </DialogActions>
    </>
  );
}

/** Asks for the title of a new dashboard, creates it and opens it. */
export function NewDashboardDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <NewDashboardForm onClose={onClose} />
    </Dialog>
  );
}
