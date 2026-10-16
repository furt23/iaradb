"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import type { NotebookView } from "@iara/protocol";
import { useEffect, useState } from "react";

import { NotebookEditor } from "@/features/notebook/NotebookEditor";
import { ErrorState } from "@/features/shell/PageHeader";
import { openNotebook } from "@/server/actions/notebooks";

type Load = { status: "idle" } | { status: "loading" } | { status: "ready"; view: NotebookView } | { status: "failed"; message: string };

/**
 * A notebook tab. It opens the notebook (and so starts its kernel) the first
 * time it is shown, not when tabs are restored.
 */
export function NotebookTab({ path, shown, schema }: { path: string; shown: boolean; schema: Record<string, { name: string }[]> }) {
  const [load, setLoad] = useState<Load>({ status: "idle" });

  useEffect(() => {
    if (!shown || load.status !== "idle") return;
    setLoad({ status: "loading" });
    void openNotebook(path).then((r) => setLoad(r.ok ? { status: "ready", view: r.data } : { status: "failed", message: r.error.message }));
  }, [shown, load.status, path]);

  if (load.status === "ready") return <NotebookEditor initial={load.view} schema={schema} />;
  if (load.status === "failed") {
    return (
      <Box>
        <ErrorState title={`Could not open ${path}`} message={load.message} />
        <Button sx={{ ml: 4 }} onClick={() => setLoad({ status: "idle" })}>
          Retry
        </Button>
      </Box>
    );
  }
  return (
    <Box sx={{ display: "flex", justifyContent: "center", pt: 8 }}>
      <CircularProgress size={22} />
    </Box>
  );
}
