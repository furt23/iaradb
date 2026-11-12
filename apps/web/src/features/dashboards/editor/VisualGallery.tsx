"use client";

import AlignHorizontalLeftOutlined from "@mui/icons-material/AlignHorizontalLeftOutlined";
import AreaChartOutlined from "@mui/icons-material/AreaChartOutlined";
import AutoAwesomeMosaicOutlined from "@mui/icons-material/AutoAwesomeMosaicOutlined";
import BarChartOutlined from "@mui/icons-material/BarChartOutlined";
import BubbleChartOutlined from "@mui/icons-material/BubbleChartOutlined";
import DonutLargeOutlined from "@mui/icons-material/DonutLargeOutlined";
import EqualizerOutlined from "@mui/icons-material/EqualizerOutlined";
import FilterAltOutlined from "@mui/icons-material/FilterAltOutlined";
import GridOnOutlined from "@mui/icons-material/GridOnOutlined";
import MultilineChartOutlined from "@mui/icons-material/MultilineChartOutlined";
import NumbersOutlined from "@mui/icons-material/NumbersOutlined";
import PercentOutlined from "@mui/icons-material/PercentOutlined";
import PieChartOutlined from "@mui/icons-material/PieChartOutlined";
import ShowChartOutlined from "@mui/icons-material/ShowChartOutlined";
import SpeedOutlined from "@mui/icons-material/SpeedOutlined";
import StackedBarChartOutlined from "@mui/icons-material/StackedBarChartOutlined";
import StackedLineChartOutlined from "@mui/icons-material/StackedLineChartOutlined";
import TableViewOutlined from "@mui/icons-material/TableViewOutlined";
import WaterfallChartOutlined from "@mui/icons-material/WaterfallChartOutlined";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Tooltip from "@mui/material/Tooltip";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { CHART_LOOKS, type LookDef, type LookId } from "./chartLooks";

/** bars that grow from the left: the columns' icon turned */
const SIDEWAYS = { transform: "rotate(90deg)" };

const ICONS: Record<LookId, ReactNode> = {
  column: <BarChartOutlined fontSize="small" />,
  stacked: <StackedBarChartOutlined fontSize="small" />,
  percent: <PercentOutlined fontSize="small" />,
  hbar: <BarChartOutlined fontSize="small" sx={SIDEWAYS} />,
  hbar_stacked: <StackedBarChartOutlined fontSize="small" sx={SIDEWAYS} />,
  hbar_percent: <AlignHorizontalLeftOutlined fontSize="small" />,
  line: <ShowChartOutlined fontSize="small" />,
  area: <AreaChartOutlined fontSize="small" />,
  area_stacked: <StackedLineChartOutlined fontSize="small" />,
  combo: <MultilineChartOutlined fontSize="small" />,
  pie: <PieChartOutlined fontSize="small" />,
  donut: <DonutLargeOutlined fontSize="small" />,
  treemap: <AutoAwesomeMosaicOutlined fontSize="small" />,
  funnel: <FilterAltOutlined fontSize="small" />,
  waterfall: <WaterfallChartOutlined fontSize="small" />,
  heatmap: <GridOnOutlined fontSize="small" />,
  matrix: <TableViewOutlined fontSize="small" />,
  counter: <NumbersOutlined fontSize="small" />,
  gauge: <SpeedOutlined fontSize="small" />,
  scatter: <BubbleChartOutlined fontSize="small" />,
  histogram: <EqualizerOutlined fontSize="small" />,
};

/** Every visual a chart can be, one click away. */
export function VisualGallery({ value, onPick }: { value: LookId | undefined; onPick(def: LookDef): void }) {
  const { t } = useTranslation();
  return (
    <Box role="radiogroup" aria-label={t("Visual")} sx={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 0.5 }}>
      {CHART_LOOKS.map((def) => {
        const on = def.id === value;
        return (
          <Tooltip key={def.id} title={t(def.label)}>
            <ButtonBase
              role="radio"
              aria-checked={on}
              aria-label={t(def.label)}
              onClick={() => !on && onPick(def)}
              sx={{
                height: 36,
                borderRadius: 1,
                border: 1,
                borderColor: on ? "primary.main" : "divider",
                color: on ? "primary.main" : "text.secondary",
                bgcolor: on ? "action.selected" : "transparent",
                "&:hover": { bgcolor: "action.hover" },
              }}
            >
              {ICONS[def.id]}
            </ButtonBase>
          </Tooltip>
        );
      })}
    </Box>
  );
}
