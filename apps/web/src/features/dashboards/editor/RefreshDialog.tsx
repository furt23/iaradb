"use client";

import PlayArrowRounded from "@mui/icons-material/PlayArrowRounded";
import StopCircleOutlined from "@mui/icons-material/StopCircleOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { RunStatusChip } from "@/features/jobs/RunStatusChip";
import { ScheduleFields } from "@/features/jobs/ScheduleFields";
import { DEFAULT_FORM, fromCron, toCron, type ScheduleForm, type ScheduleMode } from "@/features/jobs/scheduleForm";
import { usePolling } from "@/features/jobs/usePolling";
import { useGuard } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { parseCron } from "@/lib/cron";
import type { DashboardConfig } from "@/lib/dashboards/types";
import { formatDuration, formatRelative } from "@/lib/format";
import { isFinished } from "@/lib/jobs";
import { refreshNow, refreshStatus } from "@/server/actions/dashboards";
import { cancelJobRun } from "@/server/actions/jobs";

/** "by hand" is the switch; no free-form cron unless the file already has one */
const MODES: ScheduleMode[] = ["hourly", "daily", "weekdays", "weekly"];

function validCron(form: ScheduleForm): string | null {
  const cron = toCron(form);
  if (!cron) return null;
  try {
    parseCron(cron);
    return cron;
  } catch {
    return null;
  }
}

/** The last refreshes, newest first. */
function RecentRefreshes({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const guard = useGuard();
  const { data, error, reload } = usePolling(() => refreshStatus(slug), (d) => d.runs.some((r) => !isFinished(r.status)));
  const runs = data?.runs ?? [];
  const live = runs.find((r) => !isFinished(r.status));
  const anyError = runs.some((r) => r.error);
  const act = (fn: () => Promise<unknown>) =>
    void guard(async () => {
      await fn();
      await reload();
    });

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
        <Typography sx={{ fontWeight: 650, fontSize: 13, flex: 1 }}>{t("Recent refreshes")}</Typography>
        {live ? (
          <Button size="small" color="error" startIcon={<StopCircleOutlined />} onClick={() => act(async () => unwrap(await cancelJobRun(live.id)))}>
            {t("Cancel refresh")}
          </Button>
        ) : (
          <Button size="small" startIcon={<PlayArrowRounded />} disabled={!data?.published} onClick={() => act(async () => unwrap(await refreshNow(slug)))}>
            {t("Refresh now")}
          </Button>
        )}
      </Box>
      {error && <Typography sx={{ color: "error.main", fontSize: 13 }}>{error}</Typography>}
      {data && !runs.length && <Typography sx={{ color: "text.secondary", fontSize: 13 }}>{t("No refreshes yet.")}</Typography>}
      {runs.length > 0 && (
        <Paper variant="outlined">
          <Table size="small" aria-label={t("Recent refreshes")}>
            <TableHead>
              <TableRow>
                <TableCell>{t("Status")}</TableCell>
                <TableCell>{t("Started")}</TableCell>
                <TableCell>{t("Took")}</TableCell>
                {anyError && <TableCell>{t("Error")}</TableCell>}
              </TableRow>
            </TableHead>
            <TableBody>
              {runs.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <RunStatusChip status={r.status} />
                  </TableCell>
                  <TableCell title={new Date(r.startedAt).toLocaleString()}>
                    {formatRelative(r.startedAt)}
                    {r.trigger === "manual" ? ` · ${t("by hand")}` : ""}
                  </TableCell>
                  <TableCell>{r.endedAt ? formatDuration(r.endedAt - r.startedAt) : "…"}</TableCell>
                  {anyError && (
                    <TableCell title={r.error} sx={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "error.main" }}>
                      {r.error ?? ""}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}
    </Box>
  );
}

function RefreshPanel({ slug, config, published, onSave, onClose }: { slug: string; config: DashboardConfig; published: boolean; onSave(config: DashboardConfig): void; onClose(): void }) {
  const { t } = useTranslation();
  const saved = config.schedule;
  const [enabled, setEnabled] = useState(saved?.enabled ?? true);
  const [form, setForm] = useState<ScheduleForm>(saved ? fromCron(saved.cron) : { ...DEFAULT_FORM, mode: "daily" });
  const cron = validCron(form);

  return (
    <>
      <DialogTitle>{t("Scheduled refresh")}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          {!published && <Alert severity="info">{t("Publish the dashboard for its schedule to start.")}</Alert>}
          <FormControlLabel control={<Switch checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />} label={t("Refresh on a schedule")} />
          <ScheduleFields form={form} onChange={setForm} modes={MODES} disabled={!enabled} />
          <RecentRefreshes slug={slug} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("Cancel")}</Button>
        <Button
          variant="contained"
          disabled={!cron}
          onClick={() => {
            if (!cron) return;
            onSave({ ...config, schedule: { cron, enabled } });
            onClose();
          }}
        >
          {t("Save")}
        </Button>
      </DialogActions>
    </>
  );
}

/** The dashboard's scheduled refresh: when it runs, and its recent runs. */
export function RefreshDialog({
  open,
  slug,
  config,
  published,
  onSave,
  onClose,
}: {
  open: boolean;
  slug: string;
  config: DashboardConfig;
  published: boolean;
  onSave(config: DashboardConfig): void;
  onClose(): void;
}) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <RefreshPanel slug={slug} config={config} published={published} onSave={onSave} onClose={onClose} />
    </Dialog>
  );
}
