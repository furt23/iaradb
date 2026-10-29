import { useColorScheme, useTheme, type CssVarsTheme } from "@mui/material/styles";
import { useMemo } from "react";

/** colorblind-safe on the app's surfaces; series i takes slot i, always in this order */
export const SERIES = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
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
