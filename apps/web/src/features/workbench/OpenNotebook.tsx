"use client";

import { useEffect } from "react";

import { useWorkbench } from "./WorkbenchProvider";

/**
 * Rendered by the notebook routes: the URL names the notebook to show; the
 * workbench (in the root layout, so editors survive navigation) shows it.
 */
export function OpenNotebook({ path }: { path: string | null }) {
  const { follow, showFocused } = useWorkbench();
  useEffect(() => {
    if (path) follow(path);
    else showFocused();
  }, [path, follow, showFocused]);
  return null;
}
