"use client";

import Box from "@mui/material/Box";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

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

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** When a job runs: presets, or a cron expression; with when it runs next. */
export function ScheduleFields({ form, onChange }: { form: ScheduleForm; onChange(f: ScheduleForm): void }) {
  const set = (patch: Partial<ScheduleForm>) => onChange({ ...form, ...patch });
  const cron = toCron(form);
  let hint = "Runs when started from the Jobs page.";
  if (cron) {
    try {
      const next = nextRun(parseCron(cron), new Date());
      hint = `${describeCron(cron)} · next ${next ? next.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "never"}`;
    } catch (e) {
      hint = (e as Error).message;
    }
  }
  return (
    <Box>
      <Box sx={{ display: "flex", gap: 1.5, flexWrap: "wrap" }}>
        <TextField select label="Schedule" value={form.mode} onChange={(e) => set({ mode: e.target.value as ScheduleMode })} sx={{ minWidth: 200 }}>
          {MODES.map((m) => (
            <MenuItem key={m.mode} value={m.mode}>
              {m.label}
            </MenuItem>
          ))}
        </TextField>
        {form.mode === "hourly" && (
          <TextField label="At minute" type="number" value={form.minute} onChange={(e) => set({ minute: Number(e.target.value) })} sx={{ width: 120 }} />
        )}
        {form.mode === "weekly" && (
          <TextField select label="On" value={form.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })} sx={{ minWidth: 150 }}>
            {WEEKDAYS.map((d, i) => (
              <MenuItem key={d} value={i}>
                {d}
              </MenuItem>
            ))}
          </TextField>
        )}
        {(form.mode === "daily" || form.mode === "weekdays" || form.mode === "weekly") && (
          <TextField label="At (UTC)" type="time" value={form.time} onChange={(e) => set({ time: e.target.value })} sx={{ width: 140 }} slotProps={{ inputLabel: { shrink: true } }} />
        )}
        {form.mode === "custom" && (
          <TextField
            label="Cron (UTC)"
            value={form.cron}
            onChange={(e) => set({ cron: e.target.value })}
            placeholder="minute hour day month weekday"
            sx={{ minWidth: 220, "& input": { fontFamily: "'JetBrains Mono Variable', monospace" } }}
          />
        )}
      </Box>
      <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.75, fontSize: 12.5 }}>
        {hint}
      </Typography>
    </Box>
  );
}
