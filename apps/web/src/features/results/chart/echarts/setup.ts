/** The ECharts modules the charts use: only these are bundled. */

import { BarChart, FunnelChart, GaugeChart, HeatmapChart, LineChart, PieChart, ScatterChart, TreemapChart } from "echarts/charts";
import type { BarSeriesOption, FunnelSeriesOption, GaugeSeriesOption, HeatmapSeriesOption, LineSeriesOption, PieSeriesOption, ScatterSeriesOption, TreemapSeriesOption } from "echarts/charts";
import { AriaComponent, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, VisualMapContinuousComponent } from "echarts/components";
import type { AriaComponentOption, GridComponentOption, LegendComponentOption, MarkLineComponentOption, TooltipComponentOption, VisualMapComponentOption } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  FunnelChart,
  GaugeChart,
  HeatmapChart,
  LineChart,
  PieChart,
  ScatterChart,
  TreemapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  AriaComponent,
  VisualMapContinuousComponent,
  CanvasRenderer,
]);

/** an option that only uses what is registered above */
export type ChartOption = echarts.ComposeOption<
  | BarSeriesOption
  | FunnelSeriesOption
  | GaugeSeriesOption
  | HeatmapSeriesOption
  | LineSeriesOption
  | PieSeriesOption
  | ScatterSeriesOption
  | TreemapSeriesOption
  | GridComponentOption
  | TooltipComponentOption
  | LegendComponentOption
  | MarkLineComponentOption
  | AriaComponentOption
  | VisualMapComponentOption
>;

export { echarts };
