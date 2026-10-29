/** Numbers written as a NumberFormat says, in the viewer's language (pure). */

import type { NumberFormat } from "./types";

/** The Intl locale of the app's language ("pt" → "pt-BR", anything else → "en-US"). */
export function numberLocale(language: string): string {
  return language.startsWith("pt") ? "pt-BR" : "en-US";
}

/** Intl options of a format; without one, up to 2 decimals. */
function optionsOf(format: Partial<NumberFormat> | undefined): Intl.NumberFormatOptions {
  const { style = "number", decimals, currency, compact } = format ?? {};
  const options: Intl.NumberFormatOptions = { style: style === "number" ? "decimal" : style };
  if (style === "currency") options.currency = currency;
  if (decimals !== undefined) {
    options.minimumFractionDigits = decimals;
    options.maximumFractionDigits = decimals;
  } else if (!compact) {
    // compact keeps Intl's own 2 significant digits ("1.2M"); 2 fraction digits would give "1.23M"
    options.minimumFractionDigits = 0;
    options.maximumFractionDigits = 2;
  }
  if (compact) options.notation = "compact";
  return options;
}

const formatters = new Map<string, Intl.NumberFormat>();

/** `value` written as `format` says; without a format, up to 2 decimals. */
export function formatNumber(value: number, format: NumberFormat | undefined, locale: string): string {
  if (!Number.isFinite(value)) return String(value);
  const key = `${locale}|${JSON.stringify(format)}`;
  let f = formatters.get(key);
  if (!f) formatters.set(key, (f = new Intl.NumberFormat(locale, optionsOf(format))));
  return f.format(value);
}
