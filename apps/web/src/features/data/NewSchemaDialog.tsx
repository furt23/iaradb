"use client";

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useGuard, useNotify } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { type CatalogInfo, isIdentifier, validLocation } from "@/lib/catalogToml";
import { createSchema, listCatalogs } from "@/server/actions/catalog";

/** A new schema: a namespace for tables, declared in a catalog (the default one unless `catalog` names another). */
export function NewSchemaDialog({ open, onClose, catalog }: { open: boolean; onClose(): void; catalog?: string }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [target, setTarget] = useState("");
  const [catalogs, setCatalogs] = useState<CatalogInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const guard = useGuard();
  const notify = useNotify();
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setLocation("");
    setTarget(catalog ?? "");
    void listCatalogs().then((r) => {
      if (!r.ok) return;
      setCatalogs(r.data);
      setTarget((c) => c || r.data[0]?.name || "");
    });
  }, [open, catalog]);

  const trimmed = name.trim();
  const badName = trimmed !== "" && !isIdentifier(trimmed);

  const place = location.trim();
  const badLocation = place !== "" && !validLocation(place);

  const inOther = catalogs.some((c) => c.name === target && !c.isDefault);

  const create = async () => {
    if (!trimmed || badName || badLocation || busy) return;
    setBusy(true);
    const made = await guard(async () => unwrap(await createSchema(trimmed, description, place, target)));
    setBusy(false);
    if (made === undefined) return;
    onClose();
    notify(`Created schema ${inOther ? `${target}.${trimmed}` : trimmed}`, "success");
    router.refresh();
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>{t("New schema")}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField select label={t("Catalog")} value={target} onChange={(e) => setTarget(e.target.value)}>
            {catalogs.map((c) => (
              <MenuItem key={c.name} value={c.name}>
                {c.isDefault ? `${c.name} (${t("default")})` : c.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            autoFocus
            label={t("Name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
            error={badName}
            helperText={badName ? t("Letters, digits and underscores") : undefined}
          />
          <TextField label={t("Description (optional)")} value={description} onChange={(e) => setDescription(e.target.value)} />
          <TextField
            label={t("Location (optional)")}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            error={badLocation}
            placeholder="s3://bucket/prefix/"
            helperText={badLocation ? "An s3:// URL or a folder, without .." : undefined}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {t("Cancel")}
        </Button>
        <Button variant="contained" onClick={() => void create()} disabled={busy || !trimmed || badName || badLocation || !target}>
          {t("Create")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
