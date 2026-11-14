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
import { useTranslation } from "react-i18next";

import { useGuard, useNotify } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { SYSTEM_CATALOG } from "@/lib/catalogConfig";
import { isIdentifier } from "@/lib/catalogToml";
import { createCatalog } from "@/server/actions/catalog";

/** A new catalog: a top-level namespace of schemas and tables, declared in the catalog. */
export function NewCatalogDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { t } = useTranslation();
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
  const reserved = trimmed.toLowerCase() === SYSTEM_CATALOG;
  const problem =
    trimmed !== "" && !isIdentifier(trimmed)
      ? t("Letters, digits and underscores")
      : reserved
        ? t("system is the Studio's own catalog")
        : undefined;

  const create = async () => {
    if (!trimmed || problem || busy) return;
    setBusy(true);
    const made = await guard(async () => unwrap(await createCatalog(trimmed, description)));
    setBusy(false);
    if (made === undefined) return;
    onClose();
    notify(`Created catalog ${trimmed}`, "success");
    router.refresh();
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>{t("New catalog")}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            autoFocus
            label={t("Name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
            error={!!problem}
            helperText={problem}
          />
          <TextField label={t("Description (optional)")} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {t("Cancel")}
        </Button>
        <Button variant="contained" onClick={() => void create()} disabled={busy || !trimmed || !!problem}>
          {t("Create")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
