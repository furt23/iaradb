"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

import type { Columns, Load } from "./DataProvider";
import { typeLabel } from "@/lib/format";

/** The columns of a table, under its row; `indent` as the row's. */
export function ColumnList({ name, indent, columns }: { name: string; indent: number; columns: Load<Columns> | null }) {
  const note = (text: string) => (
    <Typography sx={{ pl: 6 + indent, py: 0.25, fontSize: 12, color: "text.disabled" }} noWrap title={text}>
      {text}
    </Typography>
  );
  if (!columns || columns.status === "loading") return note("Loading columns…");
  if (columns.status === "failed") return note("Columns need the default cluster");
  const cols = columns.data[name];
  if (!cols) return note("No columns: reload the catalog");
  return (
    <Box role="group" aria-label={`columns of ${name}`}>
      {cols.map((c) => (
        <Box key={c.name} title={`${c.name}: ${c.type}`} sx={{ display: "flex", gap: 1, alignItems: "baseline", pl: 6 + indent, pr: 1, py: 0.2 }}>
          <Typography noWrap sx={{ fontSize: 12.5, flexShrink: 1, minWidth: 0 }}>
            {c.name}
          </Typography>
          <Typography noWrap variant="mono" sx={{ fontSize: 11, color: "text.disabled", ml: "auto", flexShrink: 0, maxWidth: "45%" }}>
            {typeLabel(c.type)}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}
