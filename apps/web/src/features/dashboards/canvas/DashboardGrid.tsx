"use client";

import Box from "@mui/material/Box";
import { useMemo, type ReactNode } from "react";
import ReactGridLayout, { useContainerWidth, type Layout } from "react-grid-layout";
// react-resizable's own stylesheet is not needed: this one styles the handles
import "react-grid-layout/css/styles.css";

import { GRID_COLUMNS } from "@/lib/dashboards/layout";
import type { LayoutItem } from "@/lib/dashboards/types";

const GRID = { cols: GRID_COLUMNS, rowHeight: 32, margin: [12, 12] as [number, number], containerPadding: [0, 0] as [number, number] };

/**
 * The 12-column grid widgets sit on. Editable: widgets drag by their
 * `dash-drag` header and resize from the bottom-right corner; `onLayout` gets
 * the layout when a drag or resize ends. Shortcut: the columns do not collapse
 * on narrow screens, so a phone shows the desktop layout scaled down.
 */
export function DashboardGrid({
  layout,
  editable = false,
  onLayout,
  renderWidget,
}: {
  layout: LayoutItem[];
  editable?: boolean;
  onLayout?(items: LayoutItem[]): void;
  renderWidget(id: string): ReactNode;
}) {
  // measured before the first render: the server has no width to lay out by
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true });
  const items = useMemo<Layout>(() => layout.map(({ widget, x, y, w, h }) => ({ i: widget, x, y, w, h })), [layout]);
  const stopped = (next: Layout) => onLayout?.(next.map(({ i, x, y, w, h }) => ({ widget: i, x, y, w, h })));
  return (
    <Box
      ref={containerRef}
      sx={{
        "&& .react-grid-item.react-grid-placeholder": { bgcolor: "primary.main", opacity: 0.15, borderRadius: 1 },
        "&& .react-grid-item > .react-resizable-handle::after": { borderColor: "text.secondary" },
      }}
    >
      {mounted && (
        <ReactGridLayout
          width={width}
          layout={items}
          gridConfig={GRID}
          dragConfig={{ enabled: editable, handle: ".dash-drag" }}
          resizeConfig={{ enabled: editable }}
          onDragStop={stopped}
          onResizeStop={stopped}
        >
          {layout.map(({ widget }) => (
            <div key={widget}>{renderWidget(widget)}</div>
          ))}
        </ReactGridLayout>
      )}
    </Box>
  );
}
