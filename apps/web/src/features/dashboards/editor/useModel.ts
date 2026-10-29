import { createContext, useContext } from "react";

import type { Dataset } from "@/lib/dashboards/types";
import { reachable } from "@/lib/model/graph";
import type { Model, Schema } from "@/lib/model/types";

import type { FoundColumns } from "./useDatasetColumns";

const NO_MODEL: Model = { relationships: [], measures: [] };

/** The dashboard's checked model, for the widget settings: the canvas sits between them, so it comes by context. */
export const ModelContext = createContext<Model>(NO_MODEL);

/** The checked model of the dashboard being edited. */
export function useModel(): Model {
  return useContext(ModelContext);
}

/**
 * The datasets a measure chart reads besides its own: those reachable (many → one) from its dataset and from
 * the datasets of its measures. Its own dataset is left out, since its columns are listed without a prefix.
 */
export function relatedDatasets(model: Model, dataset: string, measures: string[]): string[] {
  const from = [dataset, ...model.measures.filter((m) => measures.includes(m.name)).flatMap((m) => m.datasets)];
  return [...new Set(from.flatMap((d) => reachable(model.relationships, d)))].filter((d) => d !== dataset);
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
