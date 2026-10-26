/** The floating query-plan window: where it opens, how far it can move and which query it shows (pure). */

export interface Point {
  left: number;
  top: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** the size the window opens at, and the smallest it can be resized to (its CSS min sizes too) */
export const WINDOW_SIZE: Size = { width: 1100, height: 680 };
export const MIN_WINDOW_SIZE: Size = { width: 560, height: 320 };

/** the space left around the window when it opens */
const MARGIN = 24;

/** The window's place and size when it opens: centered, and no bigger than the viewport allows. */
export function initialWindow(v: Viewport): Point & Size {
  const width = Math.max(MIN_WINDOW_SIZE.width, Math.min(WINDOW_SIZE.width, v.width - 2 * MARGIN));
  const height = Math.max(MIN_WINDOW_SIZE.height, Math.min(WINDOW_SIZE.height, v.height - 2 * MARGIN));
  return {
    left: Math.max(0, Math.round((v.width - width) / 2)),
    top: Math.max(0, Math.round((v.height - height) / 2)),
    width,
    height,
  };
}

/** A window's place kept inside the viewport: all of it when it fits, else at least its top-left corner. */
export function keepInside(p: Point, size: Size, v: Viewport): Point {
  return {
    left: clamp(p.left, 0, v.width - size.width),
    top: clamp(p.top, 0, v.height - size.height),
  };
}

/** The query shown: the one picked, when it still exists; else the latest (the last one). */
export function shownQuery(picked: number | null, count: number): number {
  return picked != null && picked < count ? picked : count - 1;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(n, hi));
}
