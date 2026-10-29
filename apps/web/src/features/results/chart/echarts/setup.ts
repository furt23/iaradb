/** The ECharts modules the charts use: only these are bundled. */

import { BarChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import type { BarSeriesOption, LineSeriesOption, PieSeriesOption, ScatterSeriesOption } from "echarts/charts";
import { AriaComponent, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import type { AriaComponentOption, GridComponentOption, LegendComponentOption, MarkLineComponentOption, TooltipComponentOption } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([BarChart, LineChart, PieChart, ScatterChart, GridComponent, TooltipComponent, LegendComponent, MarkLineComponent, AriaComponent, CanvasRenderer]);

/** an option that only uses what is registered above */
export type ChartOption = echarts.ComposeOption<
  | BarSeriesOption
  | LineSeriesOption
  | PieSeriesOption
  | ScatterSeriesOption
  | GridComponentOption
  | TooltipComponentOption
  | LegendComponentOption
  | MarkLineComponentOption
  | AriaComponentOption
>;

export { echarts };
