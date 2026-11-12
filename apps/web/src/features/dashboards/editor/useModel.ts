import { createContext, useContext } from "react";

import type { Dataset } from "@/lib/dashboards/types";
import type { Model, Schema } from "@/lib/model/types";

import type { FoundColumns } from "./useDatasetColumns";

const NO_MODEL: Model = { relationships: [], measures: [], calendars: [], params: [] };

export interface ModelState {
  /** the checked model */
  model: Model;
  /** its source, `model.py` */
  source: string;
  /** Replace the source. It is saved a moment later, or at once with `now` (resolves when it is). */
  setSource(source: string, now?: boolean): Promise<void>;
}

/** The dashboard's model for the widget settings: the canvas sits between them, so it comes by context. */
export const ModelContext = createContext<ModelState>({ model: NO_MODEL, source: "", setSource: () => Promise.resolve() });

/** The checked model of the dashboard being edited. */
export function useModel(): Model {
  return useContext(ModelContext).model;
}

/** The source of the model of the dashboard being edited, and how to change it. */
export function useModelSource(): Pick<ModelState, "source" | "setSource"> {
  return useContext(ModelContext);
}

/** The columns a model is checked against: each dataset's names once read, null until then (any name is taken). */
export function modelSchema(datasets: Dataset[], found: FoundColumns): Schema {
  const schema: Schema = {};
  for (const d of datasets) {
    const columns = found[d.name];
    schema[d.name] = Array.isArray(columns) ? columns.map((c) => c.name) : null;
  }
  return schema;
}
