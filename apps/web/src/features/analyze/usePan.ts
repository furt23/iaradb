"use client";

import { useRef, type PointerEvent } from "react";

interface Drag {
  x: number;
  y: number;
  left: number;
  top: number;
}

/**
 * Drag to pan a scrollable element. Presses on a button (a plan box) are left
 * alone, so clicks still open it.
 */
export function usePan<T extends HTMLElement>() {
  const drag = useRef<Drag | null>(null);

  const onPointerDown = (e: PointerEvent<T>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    drag.current = { x: e.clientX, y: e.clientY, left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop };
  };
  const onPointerMove = (e: PointerEvent<T>) => {
    const d = drag.current;
    if (!d) return;
    e.currentTarget.scrollLeft = d.left - (e.clientX - d.x);
    e.currentTarget.scrollTop = d.top - (e.clientY - d.y);
  };
  const stop = () => {
    drag.current = null;
  };

  return { onPointerDown, onPointerMove, onPointerUp: stop, onPointerLeave: stop, onPointerCancel: stop };
}
