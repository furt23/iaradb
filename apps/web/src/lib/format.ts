/** Human-friendly numbers, durations and sizes. */

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : ms.toFixed(0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatCount(n: number | null | undefined): string {
  if (n == null) return "";
  return n.toLocaleString("en-US");
}

export function formatCompact(n: number): string {
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

/** "just now", "5 min ago", "in 3 h": a time relative to `now` (ms). */
export function formatRelative(ms: number, now = Date.now()): string {
  const d = ms - now;
  const a = Math.abs(d);
  if (a < 45_000) return d < 0 ? "just now" : "in a moment";
  const [n, unit] = a < 3600_000 ? [Math.round(a / 60_000), "min"] : a < 86_400_000 ? [Math.round(a / 3600_000), "h"] : [Math.round(a / 86_400_000), "d"];
  return d < 0 ? `${n} ${unit} ago` : `in ${n} ${unit}`;
}

const NUMERIC = /^(u?int\d+|float\d*|double|halffloat|decimal)/;

export function isNumericType(arrowType: string): boolean {
  return NUMERIC.test(arrowType);
}
