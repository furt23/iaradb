"use client";

import type { Widget } from "@/lib/dashboards/types";

import { nameOf } from "./measureDraft";
import { appendLines } from "./measureLine";
import { removeFromWidgets, renameInWidgets, widgetsUsing, withMeasure } from "./measureWidgets";
import { removeMeasure, renameInSource, replaceMeasure } from "./modelEdits";
import { useModelSource } from "./useModel";

/**
 * What the canvas does to the model's source and to the widgets that draw its measures. The model is saved
 * before the widgets change, or a chart would be told to draw a measure the saved model lacks.
 */
export function useMeasureActions(widgets: readonly Widget[], selected: Widget | undefined, onChange: (widget: Widget, reload?: boolean) => void) {
  const { source, setSource } = useModelSource();
  return {
    /** The charts that draw the measure. */
    usedBy: (name: string) => widgetsUsing(widgets, name),
    /** Appends the lines; the measure `name` is drawn by the selected chart (a counter's replaces its own). */
    async add(lines: string[], name: string) {
      await setSource(appendLines(source, lines), true);
      if (selected?.kind === "chart") onChange(withMeasure(selected, name), true);
    },
    /** Replaces the measure `name` by the line `text`; a new name is also given to the rest of the source and to the charts. */
    async save(name: string, text: string) {
      const to = nameOf(text) ?? name;
      let next = replaceMeasure(source, name, text);
      if (to !== name) next = renameInSource(next, name, to);
      await setSource(next, true);
      // saving the model alone does not draw the charts again: they are saved too, which does
      const changed = to === name ? widgetsUsing(widgets, name) : renameInWidgets(widgets, name, to);
      for (const w of changed) onChange(w, true);
    },
    async remove(name: string) {
      await setSource(removeMeasure(source, name), true);
      for (const w of removeFromWidgets(widgets, name)) onChange(w, true);
    },
  };
}

export type MeasureActions = ReturnType<typeof useMeasureActions>;
