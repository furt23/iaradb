const MAX = 160;

/** A query on one line, cut short (pure). */
export function preview(query: string, max = MAX): string {
  const one = query.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
