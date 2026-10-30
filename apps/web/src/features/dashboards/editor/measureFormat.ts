/** The number format of a measure as the formula bar's control edits it (pure). */

import type { NumberFormat } from "@/lib/dashboards/types";

/** "auto": the measure has no format */
export type FormatStyle = "auto" | NumberFormat["style"];

export const styleOf = (format: NumberFormat | undefined): FormatStyle => format?.style ?? "auto";

/** The format without its undefined keys. */
const clean = (format: NumberFormat): NumberFormat => Object.fromEntries(Object.entries(format).filter(([, v]) => v !== undefined)) as NumberFormat;

/** The format after another style is picked (null: automatic); decimals and compact stay, a currency defaults to BRL. */
export function withStyle(current: NumberFormat | undefined, style: FormatStyle): NumberFormat | null {
  if (style === "auto") return null;
  return clean({ style, decimals: current?.decimals, compact: current?.compact, currency: style === "currency" ? (current?.currency ?? "BRL") : undefined });
}

/** The format after the decimals are typed: empty is as many as come; 0 to 10 otherwise. Null while automatic. */
export function withDecimals(current: NumberFormat | undefined, typed: string): NumberFormat | null {
  if (!current) return null;
  const n = Math.round(Number(typed));
  return clean({ ...current, decimals: typed.trim() === "" || Number.isNaN(n) ? undefined : Math.min(10, Math.max(0, n)) });
}
