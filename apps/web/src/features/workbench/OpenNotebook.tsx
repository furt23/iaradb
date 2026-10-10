"use client";

import { useEffect } from "react";

import { rememberFileId } from "./fileIdRegistry";
import { useWorkbench } from "./WorkbenchProvider";

/**
 * Rendered by the notebook routes: the URL names the notebook to show (`id`
 * is the one in the URL); the workbench (in the root layout, so editors
 * survive navigation) shows it.
 */
export function OpenNotebook({ path, id }: { path: string | null; id?: string }) {
  const { follow, showFocused } = useWorkbench();
  useEffect(() => {
    if (path && id) rememberFileId(path, id);
    if (path) follow(path);
    else showFocused();
  }, [path, id, follow, showFocused]);
  return null;
}
