/**
 * Fuzzy matching for quick open (pure): the query's characters must appear in
 * order; matches at word starts, consecutive runs and in the file name (not
 * its folder) score higher.
 */

const BOUNDARY = /[/\\_\-. ]/;

/** The score of `text` for `query` (higher is better), or null when it does not match. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
  const nameStart = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\")) + 1;
  // matched within the name alone, or anywhere: the better of the two
  const inName = matchFrom(q, t, nameStart, nameStart);
  const anywhere = matchFrom(q, t, 0, nameStart);
  if (inName === null && anywhere === null) return null;
  let score = Math.max(inName ?? -Infinity, anywhere ?? -Infinity);
  // an exact name is best; shorter texts first among equals
  const name = t.slice(nameStart);
  if (name === q || name.replace(/\.\w+$/, "") === q) score += 20;
  return score - t.length * 0.01;
}

/** Leftmost match of `q` in `t` from `start`. */
function matchFrom(q: string, t: string, start: number, nameStart: number): number | null {
  let score = 0;
  let at = start;
  let prev = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, at);
    if (i < 0) return null;
    score += 1;
    if (i === prev + 1) score += 3; // consecutive
    if (i === 0 || BOUNDARY.test(t[i - 1])) score += 4; // word start
    if (i >= nameStart) score += 2; // in the name
    prev = i;
    at = i + 1;
  }
  return score;
}

/** Items matching `query`, best first (all of them, in order, for an empty query). */
export function fuzzyFilter<T>(items: T[], query: string, text: (item: T) => string, limit = 50): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item, i) => ({ item, i, score: fuzzyScore(query, text(item)) }))
    .filter((m): m is { item: T; i: number; score: number } => m.score !== null)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((m) => m.item);
}
