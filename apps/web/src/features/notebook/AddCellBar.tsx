"use client";

import Add from "@mui/icons-material/Add";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import type { CellKind } from "@workhouse/protocol";

/** Insert a cell between two others; visible on hover (always, when `persistent`). */
export function AddCellBar({ onAdd, persistent = false }: { onAdd(kind: CellKind): void; persistent?: boolean }) {
  return (
    <Box
      sx={{
        display: "flex",
        justifyContent: "center",
        gap: 0.5,
        py: 0.5,
        opacity: persistent ? 1 : 0,
        transition: "opacity 120ms",
        "&:hover, &:focus-within": { opacity: 1 },
      }}
    >
      {(["python", "sql", "markdown"] as CellKind[]).map((kind) => (
        <Button key={kind} size="small" startIcon={<Add fontSize="small" />} onClick={() => onAdd(kind)} sx={{ color: "text.secondary", fontSize: 12 }}>
          {kind === "python" ? "Python" : kind === "sql" ? "SQL" : "Markdown"}
        </Button>
      ))}
    </Box>
  );
}
