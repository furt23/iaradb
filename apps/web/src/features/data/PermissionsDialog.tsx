"use client";

import DeleteOutline from "@mui/icons-material/DeleteOutlineOutlined";
import Alert from "@mui/material/Alert";
import Autocomplete from "@mui/material/Autocomplete";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { grantAction, listGrantsAction, revokeAction } from "@/server/actions/grants";
import type { Grant } from "@/server/governance/grants";

/** Who may read a catalog, schema or table (`on`, its grant name) through the Studio's mediated queries. */
export function PermissionsDialog({ open, on, onClose }: { open: boolean; on: string; onClose(): void }) {
  const { t } = useTranslation();
  const name = on.trim().toLowerCase();
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const quick = [
    { to: "editors", label: t("All editors") },
    { to: "viewers", label: t("All viewers") },
  ];
  const labelOf = (to: string) => quick.find((q) => q.to === to)?.label ?? to;
  const toOf = (text: string) => quick.find((q) => q.label === text.trim())?.to ?? text.trim();

  useEffect(() => {
    if (!open) return;
    setInput("");
    setError(null);
    setGrants(null);
    void listGrantsAction().then((r) => (r.ok ? setGrants(r.data) : setError(r.error.message)));
  }, [open]);

  /** Runs a grant change and shows the grants it returns; true when it worked. */
  const change = async (task: () => ReturnType<typeof grantAction>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const r = await task();
    setBusy(false);
    if (r.ok) setGrants(r.data);
    else setError(r.error.message);
    return r.ok;
  };

  const add = async () => {
    const to = toOf(input);
    if (!to || busy) return;
    if (await change(() => grantAction(to, name))) setInput("");
  };

  const direct = grants?.filter((g) => g.on === name) ?? [];
  // a grant on `*` or on a parent of this object (`sales` for `sales.main.orders`)
  const inherited = grants?.filter((g) => g.on === "*" || name.startsWith(`${g.on}.`)) ?? [];
  const origin = (on: string) =>
    on === "*" ? t("the whole workspace") : on.includes(".") ? t("schema {{name}}", { name: on }) : t("catalog {{name}}", { name: on });

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t("Permissions on {{name}}", { name: on })}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <Stack spacing={1}>
            <Typography variant="subtitle2">{t("Who can read this")}</Typography>
            {grants && direct.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                {t("No one has a direct grant.")}
              </Typography>
            )}
            {direct.map((g) => (
              <Stack key={g.to} direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <Typography variant="body2" sx={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                  {labelOf(g.to)}
                </Typography>
                <Tooltip title={t("Remove {{who}}", { who: labelOf(g.to) })}>
                  <IconButton size="small" aria-label={t("Remove {{who}}", { who: labelOf(g.to) })} onClick={() => void change(() => revokeAction(g.to, name))}>
                    <DeleteOutline fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            ))}
          </Stack>
          <Stack spacing={1}>
            <Typography variant="subtitle2">{t("Inherited")}</Typography>
            {grants && inherited.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                {t("Nothing is inherited.")}
              </Typography>
            )}
            {inherited.map((g) => (
              <Stack key={`${g.to}|${g.on}`} direction="row" spacing={1}>
                <Typography variant="body2">{labelOf(g.to)}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {t("From {{origin}}", { origin: origin(g.on) })}
                </Typography>
              </Stack>
            ))}
          </Stack>
          <Stack component="form" direction="row" spacing={1} sx={{ alignItems: "flex-start" }} onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <Autocomplete
              freeSolo
              options={quick.map((q) => q.label)}
              inputValue={input}
              onInputChange={(_, v) => setInput(v)}
              sx={{ flex: 1, minWidth: 0 }}
              renderInput={(params) => <TextField {...params} autoFocus size="small" label={t("Email, or a group")} />}
            />
            <Button type="submit" variant="contained" disabled={busy || !input.trim()} sx={{ flexShrink: 0 }}>
              {t("Add")}
            </Button>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("Close")}</Button>
      </DialogActions>
    </Dialog>
  );
}
