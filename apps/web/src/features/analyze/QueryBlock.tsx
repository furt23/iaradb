"use client";

import ExpandMoreRounded from "@mui/icons-material/ExpandMoreRounded";
import ButtonBase from "@mui/material/ButtonBase";
import Collapse from "@mui/material/Collapse";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import { useState } from "react";

import { preview } from "./preview";

/** The analyzed query: one line when collapsed, monospace in full when open. */
export function QueryBlock({ query }: { query: string }) {
  const [open, setOpen] = useState(true);
  return (
    <Paper variant="outlined" sx={{ flexShrink: 0, overflow: "hidden" }}>
      <ButtonBase
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        sx={{ width: "100%", justifyContent: "flex-start", gap: 1, px: 2, py: 1, textAlign: "left", minWidth: 0 }}
      >
        <ExpandMoreRounded sx={{ fontSize: 18, color: "text.secondary", transform: open ? "none" : "rotate(-90deg)", transition: "transform 120ms" }} />
        <Typography variant="caption" sx={{ color: "text.secondary", fontWeight: 650, textTransform: "uppercase", letterSpacing: 0.6, flexShrink: 0 }}>
          Query
        </Typography>
        {!open && (
          <Typography variant="mono" noWrap sx={{ color: "text.secondary", minWidth: 0 }}>
            {preview(query)}
          </Typography>
        )}
      </ButtonBase>
      <Collapse in={open}>
        <Typography variant="mono" component="pre" sx={{ m: 0, px: 2, pb: 1.5, whiteSpace: "pre-wrap", maxHeight: 240, overflow: "auto" }}>
          {query}
        </Typography>
      </Collapse>
    </Paper>
  );
}
