"use client";

import Box from "@mui/material/Box";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";

import { describeCron, nextRun, parseCron } from "@/lib/cron";

import { toCron, type ScheduleForm, type ScheduleMode } from "./scheduleForm";

const MODES: { mode: ScheduleMode; label: string }[] = [
  { mode: "manual", label: "By hand only" },
  { mode: "hourly", label: "Every hour" },
  { mode: "daily", label: "Every day" },
  { mode: "weekdays", label: "Weekdays (Mon–Fri)" },
  { mode: "weekly", label: "Every week" },
  { mode: "custom", label: "Custom (cron)" },
];

/** When something runs: presets, or a cron expression; with when it runs next. `modes` limits the presets (the current one always shows). */
export function ScheduleFields({
  form,
  onChange,
  modes,
  disabled,
}: {
  form: ScheduleForm;
  onChange(f: ScheduleForm): void;
  modes?: ScheduleMode[];
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const set = (patch: Partial<ScheduleForm>) => onChange({ ...form, ...patch });
  // 2026-01-04 is a Sunday
  const weekday = (i: number) => new Intl.DateTimeFormat(i18n.language, { weekday: "long", timeZone: "UTC" }).format(Date.UTC(2026, 0, 4 + i));
  const cron = toCron(form);
  let hint = "";
  if (cron) {
    try {
      const next = nextRun(parseCron(cron), new Date());
      const when = `${t("Next run")}: ${next ? `${next.toISOString().replace("T", " ").slice(0, 16)} UTC` : t("never")}`;
      hint = form.mode === "custom" ? `${describeCron(cron)} · ${when}` : when;
    } catch (e) {
      hint = (e as Error).message;
    }
  }
  return (
    <Box sx={{ opacity: disabled ? 0.6 : 1 }}>
      <Box sx={{ display: "flex", gap: 1.5, flexWrap: "wrap" }}>
        <TextField select label={t("Schedule")} value={form.mode} disabled={disabled} onChange={(e) => set({ mode: e.target.value as ScheduleMode })} sx={{ minWidth: 200 }}>
          {MODES.filter((m) => !modes || modes.includes(m.mode) || m.mode === form.mode).map((m) => (
            <MenuItem key={m.mode} value={m.mode}>
              {t(m.label)}
            </MenuItem>
          ))}
        </TextField>
        {form.mode === "hourly" && (
          <TextField
            label={t("At minute")}
            type="number"
            value={form.minute}
            disabled={disabled}
            onChange={(e) => set({ minute: Number(e.target.value) })}
            sx={{ width: 120 }}
            slotProps={{ htmlInput: { min: 0, max: 59 } }}
          />
        )}
        {form.mode === "weekly" && (
          <TextField select label={t("On")} value={form.weekday} disabled={disabled} onChange={(e) => set({ weekday: Number(e.target.value) })} sx={{ minWidth: 150 }}>
            {[1, 2, 3, 4, 5, 6, 0].map((i) => (
              <MenuItem key={i} value={i}>
                {weekday(i)}
              </MenuItem>
            ))}
          </TextField>
        )}
        {(form.mode === "daily" || form.mode === "weekdays" || form.mode === "weekly") && (
          <TextField
            label={t("At (UTC)")}
            type="time"
            value={form.time}
            disabled={disabled}
            onChange={(e) => set({ time: e.target.value })}
            sx={{ width: 140 }}
            slotProps={{ inputLabel: { shrink: true } }}
          />
        )}
        {form.mode === "custom" && (
          <TextField
            label={t("Cron (UTC)")}
            value={form.cron}
            disabled={disabled}
            onChange={(e) => set({ cron: e.target.value })}
            placeholder="minute hour day month weekday"
            sx={{ minWidth: 220, "& input": { fontFamily: "'JetBrains Mono Variable', monospace" } }}
          />
        )}
      </Box>
      {hint && (
        <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.75, fontSize: 12.5 }}>
          {hint}
        </Typography>
      )}
    </Box>
  );
}
