"use client";

import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import Box from "@mui/material/Box";
import type { CellKind } from "@workhouse/protocol";
import { memo, useMemo } from "react";

import { AddCellBar } from "./AddCellBar";
import { CellView, type CellViewProps } from "./CellView";

/** What a cell's drag handle spreads on itself. */
export interface DragHandle {
  ref(el: HTMLElement | null): void;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
}

export interface SortableCellProps extends Omit<CellViewProps, "dragHandle"> {
  index: number;
  last: boolean;
  onAddAt(index: number, kind: CellKind): void;
}

/** A cell that can be dragged by its handle, with the insert bar below it. */
function SortableCellImpl({ index, last, onAddAt, ...cell }: SortableCellProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: cell.cell.id });
  const handle = useMemo<DragHandle>(() => ({ ref: setActivatorNodeRef, attributes, listeners }), [setActivatorNodeRef, attributes, listeners]);
  return (
    <Box
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      sx={{ position: "relative", zIndex: isDragging ? 1 : "auto", opacity: isDragging ? 0.35 : 1 }}
    >
      <CellView {...cell} dragHandle={handle} />
      <AddCellBar onAdd={(k) => onAddAt(index + 1, k)} persistent={last} />
    </Box>
  );
}

export const SortableCell = memo(SortableCellImpl);
