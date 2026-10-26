"use client";

import Add from "@mui/icons-material/Add";
import MenuBookOutlined from "@mui/icons-material/MenuBookOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import { useState } from "react";

import { NewNotebookDialog } from "@/features/files/NewNotebookDialog";

import { useWorkbench } from "./WorkbenchProvider";
import { paneOf, type Pane } from "./workbenchState";

/** A pane with no tabs: pick a notebook to show in it. */
export function EmptyPane({ pane, notebooks }: { pane: Pane; notebooks: string[] }) {
  const { state, act } = useWorkbench();
  const [creating, setCreating] = useState(false);
  const show = (path: string) => {
    const at = paneOf(state, path);
    if (at) act({ type: "moveTab", path, to: pane.id });
    else act({ type: "open", path });
  };
  return (
    <Box sx={{ flex: 1, overflow: "auto", p: 3, display: "flex", flexDirection: "column", alignItems: "center" }}>
      <Box sx={{ width: "100%", maxWidth: 420 }}>
        <Typography variant="h4" sx={{ mb: 2 }}>
          Open a notebook here
        </Typography>
        {notebooks.map((path) => {
          const elsewhere = paneOf(state, path);
          return (
            <ButtonBase
              key={path}
              onClick={() => show(path)}
              sx={{ width: "100%", justifyContent: "flex-start", gap: 1, px: 1, py: 0.75, borderRadius: 1, "&:hover": { bgcolor: "action.hover" } }}
            >
              <MenuBookOutlined sx={{ fontSize: 16, color: "secondary.main" }} />
              <Typography noWrap sx={{ fontSize: 13, flex: 1, textAlign: "left" }}>
                {path}
              </Typography>
              {elsewhere && (
                <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
                  in pane {state.panes.indexOf(elsewhere) + 1} · move here
                </Typography>
              )}
            </ButtonBase>
          );
        })}
        <Button startIcon={<Add />} onClick={() => setCreating(true)} sx={{ mt: 2 }}>
          New notebook
        </Button>
      </Box>
      <NewNotebookDialog open={creating} onClose={() => setCreating(false)} />
    </Box>
  );
}
