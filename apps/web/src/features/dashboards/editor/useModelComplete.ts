"use client";

import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { EditorAssist } from "@/features/editor/assist";
import { MODEL_FUNCTIONS } from "@/lib/model/functions/registry";
import type { Model, Schema } from "@/lib/model/types";

import { modelCompletions } from "./modelCompletions";

/**
 * `assist.complete` for the model editors. It never changes: the editor rebuilds
 * its extensions (and drops an open list) whenever it gets a new function, and the
 * model changes with every keystroke, so the latest one is read from a ref.
 */
export function useModelComplete(model: Model, schema: Schema): NonNullable<EditorAssist["complete"]> {
  const { t } = useTranslation();
  const latest = useRef({ model, schema, t });
  latest.current = { model, schema, t };
  return useCallback(async (code, cursor) => {
    const { model, schema, t } = latest.current;
    return modelCompletions(code, cursor, { model, schema, functions: MODEL_FUNCTIONS, t: (key) => t(key) });
  }, []);
}
