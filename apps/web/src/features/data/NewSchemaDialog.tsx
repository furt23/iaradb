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
import { isIdentifier, validLocation } from "@/lib/catalogToml";
import { createSchema } from "@/server/actions/catalog";

/** A new schema: a namespace for tables, declared in iara.toml. */
export function NewSchemaDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const guard = useGuard();
  const notify = useNotify();
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setLocation("");
  }, [open]);

  const trimmed = name.trim();
  const badName = trimmed !== "" && !isIdentifier(trimmed);

  const place = location.trim();
  const badLocation = place !== "" && !validLocation(place);

  const create = async () => {
    if (!trimmed || badName || badLocation || busy) return;
    setBusy(true);
    const made = await guard(async () => unwrap(await createSchema(trimmed, description, place)));
    setBusy(false);
    if (made === undefined) return;
    onClose();
    notify(`Created schema ${trimmed}`, "success");
    router.refresh();
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>{t("New schema")}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            autoFocus
            label={t("Name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
            error={badName}
            helperText={badName ? t("Letters, digits and underscores") : t("Its tables are named schema.table, e.g. tpch.lineitem")}
          />
          <TextField label={t("Description (optional)")} value={description} onChange={(e) => setDescription(e.target.value)} />
          <TextField
            label={t("Location (optional)")}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            error={badLocation}
            placeholder="s3://bucket/prefix/"
            helperText={badLocation ? "An s3:// URL or a folder, without .." : t("Each subfolder becomes a table of the schema")}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {t("Cancel")}
        </Button>
        <Button variant="contained" onClick={() => void create()} disabled={busy || !trimmed || badName || badLocation}>
          {t("Create")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

