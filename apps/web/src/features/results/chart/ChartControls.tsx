"use client";

import AreaChartOutlined from "@mui/icons-material/AreaChartOutlined";
import BarChartOutlined from "@mui/icons-material/BarChartOutlined";
import BubbleChartOutlined from "@mui/icons-material/BubbleChartOutlined";
import ShowChartOutlined from "@mui/icons-material/ShowChartOutlined";
import StackedBarChartOutlined from "@mui/icons-material/StackedBarChartOutlined";
import Box from "@mui/material/Box";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import type { ChartAgg, ChartKind, ChartSpec, ColumnInfo } from "@iara/protocol";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { isNumericType } from "@/lib/format";

const KINDS: { kind: ChartKind; label: string; icon: ReactNode }[] = [
  { kind: "bar", label: "Bars", icon: <BarChartOutlined fontSize="small" /> },
  { kind: "line", label: "Line", icon: <ShowChartOutlined fontSize="small" /> },
  { kind: "area", label: "Area", icon: <AreaChartOutlined fontSize="small" /> },
  { kind: "scatter", label: "Scatter", icon: <BubbleChartOutlined fontSize="small" /> },
  { kind: "histogram", label: "Histogram", icon: <StackedBarChartOutlined fontSize="small" /> },
];

const AGGS: { agg: ChartAgg; label: string }[] = [
  { agg: "sum", label: "Sum" },
  { agg: "avg", label: "Average" },
  { agg: "count", label: "Count rows" },
  { agg: "min", label: "Min" },
  { agg: "max", label: "Max" },
  { agg: "none", label: "None (raw rows)" },
];

const FIELD = { size: "small", sx: { minWidth: 140 }, slotProps: { inputLabel: { shrink: true } } } as const;

/** What to draw: chart kind, axes, aggregation, series split. */
export function ChartControls({ spec, columns, onChange }: { spec: ChartSpec; columns: ColumnInfo[]; onChange(spec: ChartSpec): void }) {
  const { t } = useTranslation();
  const set = (patch: Partial<ChartSpec>) => onChange({ ...spec, ...patch });
  const numeric = columns.filter((c) => isNumericType(c.type));
  const histogram = spec.kind === "histogram";
  const counting = spec.agg === "count";
  return (
    <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 1.5, px: 1.5, py: 1, borderBottom: 1, borderColor: "divider" }}>
      <ToggleButtonGroup size="small" exclusive value={spec.kind} onChange={(_, kind: ChartKind | null) => kind && set({ kind })} aria-label="chart kind">
        {KINDS.map((k) => (
          <Tooltip key={k.kind} title={t(k.label)}>
            <ToggleButton value={k.kind} aria-label={t(k.label)}>
              {k.icon}
            </ToggleButton>
          </Tooltip>
        ))}
      </ToggleButtonGroup>
      <TextField {...FIELD} select label={histogram ? t("Column") : t("X axis")} value={spec.x} onChange={(e) => set({ x: e.target.value })}>
        {(histogram ? numeric : columns).map((c) => (
          <MenuItem key={c.name} value={c.name}>
            {c.name}
          </MenuItem>
        ))}
      </TextField>
      {histogram ? (
        <TextField
          {...FIELD}
          type="number"
          label={t("Buckets")}
          value={spec.bins ?? 30}
          onChange={(e) => set({ bins: Math.max(1, Math.min(200, Number(e.target.value) || 30)) })}
          sx={{ width: 100 }}
        />
      ) : (
        <>
          <TextField {...FIELD} select label={t("Aggregation")} value={spec.agg} onChange={(e) => set({ agg: e.target.value as ChartAgg })}>
            {AGGS.map((a) => (
              <MenuItem key={a.agg} value={a.agg}>
                {t(a.label)}
              </MenuItem>
            ))}
          </TextField>
          {!counting && (
            <TextField
              {...FIELD}
              select
              label={t("Values")}
              value={spec.y}
              onChange={(e) => set({ y: typeof e.target.value === "string" ? e.target.value.split(",") : (e.target.value as string[]) })}
              slotProps={{ ...FIELD.slotProps, select: { multiple: true, renderValue: (v) => (v as string[]).join(", ") } }}
            >
              {(spec.agg === "none" ? columns : numeric).map((c) => (
                <MenuItem key={c.name} value={c.name}>
                  {c.name}
                </MenuItem>
              ))}
            </TextField>
          )}
        </>
      )}
      <TextField {...FIELD} select label={t("Split by")} value={spec.group ?? ""} onChange={(e) => set({ group: e.target.value || null })}>
        <MenuItem value="">
          <em>{t("Nothing")}</em>
        </MenuItem>
        {columns
          .filter((c) => c.name !== spec.x)
          .map((c) => (
            <MenuItem key={c.name} value={c.name}>
              {c.name}
            </MenuItem>
          ))}
      </TextField>
    </Box>
  );
}

