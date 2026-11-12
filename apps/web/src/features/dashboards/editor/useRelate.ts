"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { Dataset } from "@/lib/dashboards/types";
import type { ColumnRef } from "@/lib/model/types";
import { uniqueColumnsAction } from "@/server/actions/dashboards";

import { appendLines } from "./measureLine";
import { orient, relateLine, relateProblem } from "./relationships";
import type { FoundColumns } from "./useDatasetColumns";
import { modelSchema, useModelSource } from "./useModel";

/** Connects two columns: reads which is unique, to point the relationship the right way, and adds it to the model. */
export function useRelate(slug: string, datasets: Dataset[], found: FoundColumns) {
  const { t } = useTranslation();
  const { source, setSource } = useModelSource();
  const [busy, setBusy] = useState(false);

  /** Why they could not be connected, or null once they are. */
  const connect = async (a: ColumnRef, b: ColumnRef): Promise<string | null> => {
    setBusy(true);
    try {
      const r = await uniqueColumnsAction(slug, [a, b]);
      if (!r.ok) return r.error.message;
      const way = orient(a, b, [r.data[0], r.data[1]]);
      if (!way) return t("Neither column has one row per value, so their rows cannot be matched. Relate a table that has one row per {{column}}.", { column: b.column });
      const line = relateLine(way.many, way.one);
      const why = relateProblem(source, line, modelSchema(datasets, found));
      if (why) return why;
      await setSource(appendLines(source, [line]));
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { connect, busy };
}
