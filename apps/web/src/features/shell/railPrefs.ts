/**
 * The navigation rail's width preference, remembered by the browser (pure).
 * Expanded shows the section names next to the icons; collapsed shows icons only.
 */

export const RAIL_KEY = "workhouse.rail";

/** Expanded unless the browser stored "collapsed" (or nothing usable). */
export function railExpandedFrom(stored: string | null | undefined): boolean {
  return stored !== "collapsed";
}

export function railStoredValue(expanded: boolean): "expanded" | "collapsed" {
  return expanded ? "expanded" : "collapsed";
}
