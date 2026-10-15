"use client";

import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  pointerWithin,
  PointerSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import DragIndicator from "@mui/icons-material/DragIndicator";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import type { Cell } from "@iara/protocol";
import { useState, type ReactNode } from "react";

/** The cell under the pointer: cells are tall, so their centers say little. */
const underPointer: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length ? hits : closestCenter(args);
};

/** A compact stand-in for the cell being dragged (cells can be very tall). */
function DragPreview({ cell }: { cell: Cell }) {
  const lines = cell.code.split("\n").filter((l) => l.trim()).slice(0, 3);
  return (
    <Paper elevation={8} sx={{ px: 1.5, py: 1, display: "flex", gap: 1, alignItems: "flex-start", borderLeft: 3, borderLeftColor: "secondary.main", cursor: "grabbing" }}>
      <DragIndicator fontSize="small" sx={{ color: "text.disabled", mt: 0.25 }} />
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="overline" sx={{ color: "text.secondary", lineHeight: 1.6 }}>
          {cell.kind}
          {cell.kind === "sql" && cell.output ? ` → ${cell.output}` : ""}
        </Typography>
        {lines.map((l, i) => (
          <Typography key={i} variant="mono" noWrap sx={{ display: "block", fontSize: 12, color: "text.secondary" }}>
            {l}
          </Typography>
        ))}
        {!lines.length && (
          <Typography variant="mono" sx={{ fontSize: 12, color: "text.disabled" }}>
            empty cell
          </Typography>
        )}
      </Box>
    </Paper>
  );
}

/** Cells reorderable by dragging their handle (or with the keyboard: Space, arrows, Space). */
export function CellList({ cells, onReorder, children }: { cells: Cell[]; onReorder(id: string, over: string): void; children: ReactNode }) {
  const [active, setActive] = useState<Cell | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onStart = (e: DragStartEvent) => setActive(cells.find((c) => c.id === e.active.id) ?? null);
  const onEnd = (e: DragEndEvent) => {
    setActive(null);
    if (e.over && e.active.id !== e.over.id) onReorder(String(e.active.id), String(e.over.id));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={underPointer} modifiers={[restrictToVerticalAxis]} onDragStart={onStart} onDragEnd={onEnd} onDragCancel={() => setActive(null)}>
      <SortableContext items={cells.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
      <DragOverlay dropAnimation={null}>{active && <DragPreview cell={active} />}</DragOverlay>
    </DndContext>
  );
}
