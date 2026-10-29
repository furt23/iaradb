"use client";

import DeleteOutline from "@mui/icons-material/DeleteOutlineOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import type { ColumnInfo } from "@iara/protocol";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { canPick } from "@/lib/dashboards/query";
import type { Dashboard, LayoutItem, Widget } from "@/lib/dashboards/types";

import { CrossFilterBar } from "../canvas/CrossFilterBar";
import { DashboardGrid } from "../canvas/DashboardGrid";
import type { useDashboardData } from "../canvas/useDashboardData";
import { WidgetBody } from "../canvas/WidgetBody";
import { WidgetFrame } from "../canvas/WidgetFrame";
import { AddWidgetMenu } from "./AddWidgetMenu";
import { paramSpecOf } from "./datasets";
import type { NewKind } from "./newWidget";
import { widgetLabel } from "./newWidget";
import type { FoundColumns } from "./useDatasetColumns";
import { WidgetPanel } from "./WidgetPanel";

/**
 * The canvas: widgets on the grid (drag by the header, resize from the corner),
 * with live data and filters, and the settings of the selected one on the right.
 */
export function CanvasTab({
  dashboard,
  data,
  selected,
  found,
  load,
  onSelect,
  onAdd,
  onChange,
  onLayout,
  onRemove,
}: {
  dashboard: Dashboard;
  data: ReturnType<typeof useDashboardData>;
  selected: string | null;
  found: FoundColumns;
  load(name: string): Promise<ColumnInfo[]>;
  onSelect(id: string | null): void;
  onAdd(kind: NewKind): void;
  onChange(widget: Widget, reload?: boolean): void;
  onLayout(items: LayoutItem[]): void;
  onRemove(id: string): void;
}) {
  const { t } = useTranslation();
  const [deleting, setDeleting] = useState<Widget | null>(null);
  const byId = useMemo(() => new Map(dashboard.widgets.map((w) => [w.id, w])), [dashboard.widgets]);
  const current = selected ? byId.get(selected) : undefined;

  const renderWidget = (id: string) => {
    const w = byId.get(id);
    if (!w) return null;
    const title = w.kind === "text" ? undefined : w.title;
    const shown = data.result?.widgets[id];
    return (
      <WidgetFrame
        title={title}
        notes={shown?.kind === "chart" ? shown.notes : undefined}
        selected={id === selected}
        draggable
        onClick={() => onSelect(id)}
        actions={
          <IconButton
            size="small"
            aria-label={`${t("Delete")} ${title ?? t(widgetLabel(w))}`}
            onClick={(e) => {
              e.stopPropagation();
              setDeleting(w);
            }}
          >
            <DeleteOutline fontSize="small" />
          </IconButton>
        }
      >
        <WidgetBody
          widget={w}
          data={shown}
          loading={data.loading}
          filterValue={data.values[id]}
          onFilterValue={(value) => data.setValue(id, value)}
          paramSpec={w.kind === "filter" && w.param ? paramSpecOf(dashboard.datasets, w.param) : undefined}
          onPick={w.kind === "chart" && canPick(w.spec) ? (value) => data.setPick(id, value) : undefined}
          picked={data.cross.find((p) => p.widget === id)?.value}
        />
      </WidgetFrame>
    );
  };

  return (
    <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>
      <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, px: 2, py: 1, borderBottom: 1, borderColor: "divider", flexShrink: 0 }}>
          <AddWidgetMenu hasDatasets={dashboard.datasets.length > 0} onAdd={onAdd} />
          {data.error && (
            <Typography noWrap role="alert" sx={{ fontSize: 13, color: "error.main", minWidth: 0 }} title={data.error}>
              {data.error}
            </Typography>
          )}
        </Box>
        <CrossFilterBar
          cross={data.cross}
          widgets={dashboard.widgets}
          onClear={(id) => data.setPick(id, undefined)}
          onClearAll={data.clearPicks}
          sx={{ px: 2, py: 1, borderBottom: 1, borderColor: "divider", flexShrink: 0 }}
        />
        {/* a click on the empty canvas deselects */}
        <Box onClick={(e) => e.target === e.currentTarget && onSelect(null)} sx={{ flex: 1, overflow: "auto", p: 2 }}>
          {!dashboard.widgets.length && (
            <Typography sx={{ textAlign: "center", color: "text.secondary", py: 8 }}>
              {t("No widgets yet")}
            </Typography>
          )}
          <DashboardGrid layout={dashboard.layout} editable onLayout={onLayout} renderWidget={renderWidget} />
        </Box>
      </Box>
      {current && <WidgetPanel key={current.id} widget={current} datasets={dashboard.datasets} found={found} load={load} onChange={onChange} onClose={() => onSelect(null)} />}
      <Dialog open={deleting !== null} onClose={() => setDeleting(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{t("Delete this widget?")}</DialogTitle>
        <DialogActions>
          <Button onClick={() => setDeleting(null)}>{t("Cancel")}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              onRemove(deleting!.id);
              setDeleting(null);
            }}
          >
            {t("Delete")}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
