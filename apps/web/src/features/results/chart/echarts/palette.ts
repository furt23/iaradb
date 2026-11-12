import { useColorScheme, useTheme, type CssVarsTheme } from "@mui/material/styles";
import { useMemo } from "react";

import type { ChartPalette } from "@/lib/dashboards/types";

/** colorblind-safe on the app's surfaces; series i takes slot i, always in this order */
export const SERIES = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};

/** the palettes an author can give a chart; mid tones, readable on the light and dark surfaces */
export const PALETTES: Record<ChartPalette, string[]> = {
  ocean: ["#0b6fa4", "#17a2b8", "#2bc4a8", "#5b8def", "#264e86", "#74c0d8", "#00897b", "#7e9cc6"],
  sunset: ["#e4572e", "#f3a712", "#d7263d", "#ff7f51", "#a8324a", "#f2c14e", "#c2410c", "#e07a9b"],
  forest: ["#2f7d32", "#7cb342", "#00897b", "#a68a3a", "#558b6e", "#c0ca33", "#2e6f8e", "#8d6e63"],
  berry: ["#8e24aa", "#d81b60", "#5e35b1", "#ec407a", "#ab47bc", "#7e57c2", "#c2185b", "#9575cd"],
  earth: ["#8d6e63", "#c08a3e", "#6d8b74", "#b5651d", "#a1887f", "#5d7b6f", "#d4a373", "#7a6c5d"],
  mono: ["#1f5fa8", "#3a7bc8", "#5a96db", "#7fb0e6", "#a3c7ef", "#174a84", "#0f3460", "#c3daf5"],
};

export interface ChartColors {
  series: string[];
  text: string;
  muted: string;
  grid: string;
  /** behind tooltips, and the gap between pie slices */
  surface: string;
}

/** The chart colors of the active color scheme (a canvas cannot read CSS variables, so these are the resolved values). */
export function useChartColors(): ChartColors {
  const theme = useTheme<CssVarsTheme>();
  const { mode, systemMode } = useColorScheme();
  const scheme = (mode === "system" ? systemMode : mode) ?? "light";
  return useMemo(() => {
    const palette = theme.colorSchemes[scheme]?.palette ?? theme.palette;
    return { series: SERIES[scheme], text: palette.text.primary, muted: palette.text.secondary, grid: palette.divider, surface: palette.background.paper };
  }, [theme, scheme]);
}
