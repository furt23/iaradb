/**
 * Five-field cron schedules (`minute hour day-of-month month day-of-week`),
 * in UTC (pure). Fields take `*`, numbers, ranges `a-b`, lists `a,b` and
 * steps `*\/n` or `a-b/n`; days of week are 0-6 from Sunday (7 is Sunday too).
 * As in cron, when both day fields are restricted a day matching either runs.
 */

export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** each day field was `*` */
  anyDay: boolean;
  anyWeekday: boolean;
}

const FIELDS: [string, number, number][] = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day of month", 1, 31],
  ["month", 1, 12],
  ["day of week", 0, 7],
];

function field(text: string, [what, lo, hi]: [string, number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`bad ${what}: ${part}`);
    const step = m[4] ? Number(m[4]) : 1;
    const from = m[1] === "*" ? lo : Number(m[2]);
    const to = m[1] === "*" ? hi : m[3] !== undefined ? Number(m[3]) : m[4] ? hi : from;
    if (step < 1 || from < lo || to > hi || from > to) throw new Error(`bad ${what}: ${part} (allowed ${lo}-${hi})`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("a schedule has 5 fields: minute hour day-of-month month day-of-week");
  const [minutes, hours, days, months, weekdays] = parts.map((p, i) => field(p, FIELDS[i]));
  if (weekdays.delete(7)) weekdays.add(0);
  return { minutes, hours, days, months, weekdays, anyDay: parts[2] === "*", anyWeekday: parts[4] === "*" };
}

function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.days.has(d.getUTCDate());
  const dow = c.weekdays.has(d.getUTCDay());
  if (c.anyDay && c.anyWeekday) return true;
  if (c.anyDay) return dow;
  if (c.anyWeekday) return dom;
  return dom || dow;
}

/** The first time strictly after `after` the schedule fires (null: none within ~5 years). */
export function nextRun(c: Cron, after: Date): Date | null {
  const t = new Date(after.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  const limit = after.getTime() + 5 * 366 * 86_400_000;
  while (t.getTime() <= limit) {
    if (!c.months.has(t.getUTCMonth() + 1)) {
      t.setUTCMonth(t.getUTCMonth() + 1, 1);
      t.setUTCHours(0, 0);
    } else if (!dayMatches(c, t)) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0);
    } else if (!c.hours.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0);
    } else if (!c.minutes.has(t.getUTCMinutes())) {
      t.setUTCMinutes(t.getUTCMinutes() + 1);
    } else {
      return t;
    }
  }
  return null;
}

/** The last time at or before `at` the schedule fired, looking back up to `within` ms. */
export function lastRun(c: Cron, at: Date, within = 7 * 86_400_000): Date | null {
  let t = nextRun(c, new Date(at.getTime() - within));
  let last: Date | null = null;
  while (t && t.getTime() <= at.getTime()) {
    last = t;
    t = nextRun(c, t);
  }
  return last;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A short reading of common schedules ("every day at 06:00 UTC"); the expression otherwise. */
export function describeCron(expr: string): string {
  const p = expr.trim().split(/\s+/);
  if (p.length !== 5) return expr;
  const [mi, h, dom, mo, dow] = p;
  const num = (s: string) => /^\d+$/.test(s);
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  if (mi === "*" && h === "*" && dom === "*" && mo === "*" && dow === "*") return "every minute";
  const step = /^\*\/(\d+)$/.exec(mi);
  if (step && h === "*" && dom === "*" && mo === "*" && dow === "*") return `every ${step[1]} minutes`;
  if (num(mi) && h === "*" && dom === "*" && mo === "*" && dow === "*") return `every hour at :${pad(Number(mi))}`;
  if (num(mi) && /^\d+(,\d+)*$/.test(h) && mo === "*") {
    const time = `${h
      .split(",")
      .map((x) => `${pad(Number(x))}:${pad(Number(mi))}`)
      .join(", ")} UTC`;
    if (dom === "*" && dow === "*") return `every day at ${time}`;
    if (dom === "*" && dow === "1-5") return `weekdays at ${time}`;
    if (dom === "*" && num(dow)) return `every ${days[Number(dow)]} at ${time}`;
    if (num(dom) && dow === "*") return `monthly on day ${dom} at ${time}`;
  }
  return `${expr} (UTC)`;
}
