"use client";

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useTranslation } from "react-i18next";

import { useGuard } from "@/features/shell/notify";
import { useWorkbench } from "@/features/workbench/WorkbenchProvider";
import { unwrap } from "@/lib/action";
import { joinPath } from "@/lib/paths";
import { createQuery } from "@/server/actions/queries";

/** A new `.sql` file (with `text`: the scratch query being saved), opened in the workbench. */
export function NewQueryDialog({ open, onClose, folder = "queries", text }: { open: boolean; onClose(): void; folder?: string; text?: string }) {
  const { t } = useTranslation();
  const [name, setName] = useState(joinPath(folder, "untitled.sql"));
  const [busy, setBusy] = useState(false);
  const { act } = useWorkbench();
  const guard = useGuard();
  const router = useRouter();
  useEffect(() => {
    if (open) setName(joinPath(folder, "untitled.sql"));
  }, [open, folder]);

  const create = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    const made = await guard(async () => unwrap(await createQuery(name, text)));
    setBusy(false);
    if (!made) return;
    onClose();
    act({ type: "open", path: made.path }, true);
    router.refresh();
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{text === undefined ? t("New SQL query") : t("Save the query")}</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          label={t("Query path in the workspace")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void create()}
          helperText={t("A .sql file: versioned with the workspace, run on the default cluster")}
          sx={{ mt: 1 }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("Cancel")}</Button>
        <Button variant="contained" onClick={() => void create()} disabled={busy || !name.trim()}>
          {text === undefined ? t("Create") : t("Save")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

