"use client";

import { useEffect, useState, type RefObject } from "react";

/** The height of an element, kept up to date as it resizes (0 before it mounts). */
export function useElementHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setHeight(Math.floor(entry.contentRect.height)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}
