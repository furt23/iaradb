"use client";

import Refresh from "@mui/icons-material/Refresh";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { formatRelative } from "@/lib/format";
import { pickableIds } from "@/lib/dashboards/query";
import type { ViewDashboard } from "@/lib/dashboards/types";
import { renderShared } from "@/server/actions/view";

import { CrossFilterBar } from "../canvas/CrossFilterBar";
import { DashboardGrid } from "../canvas/DashboardGrid";
import { useDashboardData } from "../canvas/useDashboardData";
import { WidgetBody } from "../canvas/WidgetBody";
import { WidgetFrame } from "../canvas/WidgetFrame";

/** The current time, renewed every `ms`, so "5 min ago" stays true. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** A published dashboard as its viewers see it: the widgets on their grid, the filters live, no editing. */
export function SharedDashboard({ view }: { view: ViewDashboard }) {
  const { t } = useTranslation();
  const pickable = useMemo(() => pickableIds(view.widgets), [view.widgets]);
  const { result, loading, error, values, setValue, cross, setPick, clearPicks, refresh } = useDashboardData((v, c) => renderShared(view.id, v, c), undefined, pickable);
  const now = useNow(30_000);
  const widgets = useMemo(() => new Map(view.widgets.map((w) => [w.id, w])), [view.widgets]);
  return (
    <Box sx={{ p: 3, display: "flex", flexDirection: "column", gap: 2 }}>
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 2 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h2">{view.title}</Typography>
          {view.description && (
            <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>
              {view.description}
            </Typography>
          )}
        </Box>
        {result && (
          <Typography sx={{ color: "text.secondary", fontSize: 12, alignSelf: "center", whiteSpace: "nowrap" }}>
            {t("Updated {{when}}", { when: formatRelative(result.at, now) })}
          </Typography>
        )}
        <Button variant="outlined" startIcon={<Refresh />} onClick={refresh} disabled={loading}>
          {t("Refresh")}
        </Button>
      </Box>
      {error && <Alert severity="error">{error}</Alert>}
      <CrossFilterBar cross={cross} widgets={view.widgets} onClear={(id) => setPick(id, undefined)} onClearAll={clearPicks} />
      <DashboardGrid
        layout={view.layout}
        renderWidget={(id) => {
          const widget = widgets.get(id);
          if (!widget) return null;
          return (
            // a filter's control carries its title, a text widget has none
            <WidgetFrame title={widget.kind === "chart" || widget.kind === "table" ? widget.title : undefined}>
              <WidgetBody
                widget={widget}
                data={widget.kind === "text" ? undefined : result?.widgets[id]}
                loading={loading}
                filterValue={values[id]}
                onFilterValue={(value) => setValue(id, value)}
                paramSpec={widget.kind === "filter" && widget.param ? view.params[widget.param] : undefined}
                onPick={pickable.has(id) ? (value) => setPick(id, value) : undefined}
                picked={cross.find((p) => p.widget === id)?.value}
              />
            </WidgetFrame>
          );
        }}
      />
    </Box>
  );
}
