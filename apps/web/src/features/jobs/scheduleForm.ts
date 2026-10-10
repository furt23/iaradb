/** A schedule as people pick it (by hand, hourly, daily at...), to and from cron (pure). */

export type ScheduleMode = "manual" | "hourly" | "daily" | "weekdays" | "weekly" | "custom";

export interface ScheduleForm {
  mode: ScheduleMode;
  /** `HH:MM`, UTC (daily, weekdays, weekly) */
  time: string;
  /** minute of the hour (hourly) */
  minute: number;
  /** 0 = Sunday (weekly) */
  weekday: number;
  /** the expression (custom) */
  cron: string;
}

export const DEFAULT_FORM: ScheduleForm = { mode: "manual", time: "06:00", minute: 0, weekday: 1, cron: "0 6 * * *" };

function hm(time: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  const [h, mi] = m ? [Number(m[1]), Number(m[2])] : [6, 0];
  return [Math.min(23, h), Math.min(59, mi)];
}

export function toCron(f: ScheduleForm): string | null {
  const [h, m] = hm(f.time);
  switch (f.mode) {
    case "manual":
      return null;
    case "hourly":
      return `${Math.max(0, Math.min(59, Math.round(f.minute)))} * * * *`;
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly":
      return `${m} ${h} * * ${f.weekday}`;
    case "custom":
      return f.cron.trim() || null;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

export function fromCron(cron: string | null): ScheduleForm {
  if (!cron) return DEFAULT_FORM;
  const p = cron.trim().split(/\s+/);
  const num = (s: string | undefined) => s !== undefined && /^\d+$/.test(s);
  const base = { ...DEFAULT_FORM, cron };
  if (p.length === 5 && num(p[0]) && p[1] === "*" && p[2] === "*" && p[3] === "*" && p[4] === "*") {
    return { ...base, mode: "hourly", minute: Number(p[0]) };
  }
  if (p.length === 5 && num(p[0]) && num(p[1]) && p[2] === "*" && p[3] === "*") {
    const time = `${pad(Number(p[1]))}:${pad(Number(p[0]))}`;
    if (p[4] === "*") return { ...base, mode: "daily", time };
    if (p[4] === "1-5") return { ...base, mode: "weekdays", time };
    if (num(p[4]) && Number(p[4]) <= 7) return { ...base, mode: "weekly", time, weekday: Number(p[4]) % 7 };
  }
  return { ...base, mode: "custom" };
}
