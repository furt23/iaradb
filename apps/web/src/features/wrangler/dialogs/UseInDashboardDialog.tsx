"use client";

import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { datasetNameFor } from "@/features/dashboards/editor/datasets";
import { DATASET_NAME } from "@/lib/dashboards/query";
import type { DashboardSummary } from "@/lib/dashboards/types";
import { createDashboardAction, listDashboardsAction, saveRecipeAction } from "@/server/actions/dashboards";

import type { WranglerStep } from "../types";

/** The choice of a new dashboard: not a slug, which never starts with "+". */
const NEW = "+new";

function UseForm({ table, steps, onClose }: { table: string; steps: WranglerStep[]; onClose(): void }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [dashboards, setDashboards] = useState<DashboardSummary[] | null>(null);
  const [choice, setChoice] = useState(NEW);
  const [title, setTitle] = useState("");
  const [name, setName] = useState(() => datasetNameFor(table, []));
  // the dashboard this dialog made: a save that fails is retried in it, not in a second new one
  const [created, setCreated] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listDashboardsAction().then((r) => {
      if (!r.ok) setError(r.error.message);
      else {
        setDashboards(r.data.dashboards);
        setChoice(r.data.dashboards[0]?.slug ?? NEW);
      }
    });
  }, []);

  const target = created ?? choice;
  const problem = name && !DATASET_NAME.test(name) ? t("Use lowercase letters, digits and _ (up to 64).") : null;
  const ready = dashboards !== null && DATASET_NAME.test(name) && (target !== NEW || title.trim() !== "") && !busy;

  const save = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    let slug = target;
    if (slug === NEW) {
      const made = await createDashboardAction(title.trim());
      if (!made.ok) {
        setError(made.error.message);
        setBusy(false);
        return;
      }
      slug = made.data.slug;
      setCreated(slug);
    }
    const r = await saveRecipeAction(slug, name, { source: { table }, steps });
    setBusy(false);
    if (r.ok) setSaved(slug);
    else setError(r.error.message);
  };

  return (
    <>
      <DialogTitle>{t("Use in dashboard")}</DialogTitle>
      <DialogContent>
        {saved !== null ? (
          <Typography variant="body2" sx={{ pt: 1 }}>
            {t("Dataset {{name}} saved.", { name })}
          </Typography>
        ) : (
          <Stack spacing={2} sx={{ pt: 1 }}>
            <FormControl fullWidth size="small" disabled={created !== null || dashboards === null}>
              <InputLabel>{t("Dashboard")}</InputLabel>
              <Select value={choice} label={t("Dashboard")} onChange={(e) => setChoice(e.target.value)}>
                {dashboards?.map((d) => (
                  <MenuItem key={d.slug} value={d.slug}>
                    {d.title}
                  </MenuItem>
                ))}
                <MenuItem value={NEW}>{t("New dashboard")}</MenuItem>
              </Select>
            </FormControl>
            {choice === NEW && (
              <TextField
                label={t("Dashboard title")}
                value={title}
                disabled={created !== null}
                onChange={(e) => setTitle(e.target.value)}
                slotProps={{ htmlInput: { maxLength: 120 } }}
              />
            )}
            <TextField
              label={t("Dataset name")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void save()}
              error={problem !== null}
              helperText={problem}
            />
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {saved !== null ? (
          <>
            <Button onClick={onClose}>{t("Close")}</Button>
            <Button
              variant="contained"
              onClick={() => {
                router.push(`/dashboards/${saved}`);
                onClose();
              }}
            >
              {t("Open dashboard")}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>{t("Cancel")}</Button>
            <Button variant="contained" disabled={!ready} onClick={() => void save()}>
              {t("Save")}
            </Button>
          </>
        )}
      </DialogActions>
    </>
  );
}

/** Saves the Wrangler recipe as a dataset of a dashboard (a new one or an existing one), then offers to open it. */
export function UseInDashboardDialog({
  open,
  table,
  steps,
  onClose,
}: {
  open: boolean;
  table: string;
  steps: WranglerStep[];
  onClose(): void;
}) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <UseForm table={table} steps={steps} onClose={onClose} />
    </Dialog>
  );
}
