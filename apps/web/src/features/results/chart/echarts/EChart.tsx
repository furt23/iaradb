"use client";

import Box from "@mui/material/Box";
import { useEffect, useRef } from "react";

import { echarts, type ChartOption } from "./setup";

/** a data item: a value, an [x, y] pair, or either with styling */
type Item = number | null | number[] | { value: number | null | number[] };

/** The index of the item nearest to `x`; a value without an x sits at its index (a category axis counts its categories). */
function nearest(data: Item[], x: number): number {
  let best = -1;
  let gap = Infinity;
  data.forEach((item, i) => {
    const v = item !== null && typeof item === "object" && !Array.isArray(item) ? item.value : item;
    const d = Math.abs((Array.isArray(v) ? v[0] : i) - x);
    if (d < gap) [best, gap] = [i, d];
  });
  return best;
}

/**
 * An ECharts chart in a box `height` tall and as wide as its parent. With
 * `onPick`, a click calls it with the index of what was clicked: the slice
 * under the pointer (`pickBy` "item"), or the category under the pointer
 * anywhere inside the grid (`pickBy` "axis", the default), not only on its bar.
 */
export function EChart({
  option,
  height,
  ariaLabel,
  onPick,
  pickBy = "axis",
}: {
  option: ChartOption;
  height: number;
  /** replaces the description ECharts writes of the chart for screen readers */
  ariaLabel?: string;
  onPick?(index: number): void;
  pickBy?: "axis" | "item";
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts>(null);
  // the chart's click handlers are bound once: they read the newest props from here
  const latest = useRef({ onPick, pickBy });
  useEffect(() => {
    latest.current = { onPick, pickBy };
  });

  useEffect(() => {
    const c = echarts.init(host.current);
    chart.current = c;
    c.on("click", "series", (e) => {
      if (latest.current.pickBy === "item") latest.current.onPick?.(e.dataIndex);
    });
    c.getZr().on("click", (e) => {
      const { onPick: pick, pickBy: by } = latest.current;
      const at = [e.offsetX, e.offsetY];
      if (by !== "axis" || !pick || !c.containPixel("grid", at)) return;
      const [x] = c.convertFromPixel({ gridIndex: 0 }, at) as number[];
      const i = nearest((c.getOption().series as { data: Item[] }[])[0].data, x);
      if (i >= 0) pick(i);
    });
    const observer = new ResizeObserver(() => c.resize());
    observer.observe(host.current!);
    return () => {
      observer.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(ariaLabel ? { ...option, aria: { ...option.aria, label: { description: ariaLabel } } } : option, { notMerge: true });
  }, [option, ariaLabel]);

  return <Box ref={host} sx={{ width: "100%", height, ...(onPick && { "& canvas": { cursor: "pointer !important" } }) }} />;
}
