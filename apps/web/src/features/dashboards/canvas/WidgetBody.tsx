"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import LinearProgress from "@mui/material/LinearProgress";
import Skeleton from "@mui/material/Skeleton";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import type { CellValue } from "@iara/protocol";
import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { ChartCanvas } from "@/features/results/chart/ChartCanvas";
import type { ParamSpec } from "@/features/queries/queryHeader";
import { formatCount, isNumericType } from "@/lib/format";
import { chartMissing, drawnNames } from "@/lib/dashboards/chartFields";
import { cellTint, columnRange, tintBackground } from "@/lib/dashboards/conditional";
import { formatNumber, numberLocale } from "@/lib/dashboards/numberFormat";
import type { ChartStyle, ChartWidget, FilterValue, FilterWidget, NumberFormat, PickValue, TableWidget, TextWidget, Widget, WidgetData } from "@/lib/dashboards/types";
import { useElementHeight } from "@/lib/useElementHeight";

import { FilterControl } from "./FilterControl";
import { DASH_TABLE_SX, MatrixView } from "./MatrixView";

const MONO = "'JetBrains Mono Variable', monospace";

/** A number's value, or null: a number, or a numeric string. */
function numberOf(value: CellValue): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function Cell({ value, format, locale }: { value: CellValue; format?: NumberFormat; locale: string }) {
  if (value === null) return <Box component="span" sx={{ color: "text.disabled" }}>null</Box>;
  const n = format ? numberOf(value) : null;
  if (n !== null) return <>{formatNumber(n, format, locale)}</>;
  return <>{typeof value === "object" ? JSON.stringify(value) : String(value)}</>;
}

function TableView({ widget, data }: { widget: TableWidget; data: Extract<WidgetData, { kind: "table" }> }) {
  const { t, i18n } = useTranslation();
  const numeric = data.columns.map((c) => isNumericType(c.type));
  const locale = numberLocale(i18n.language);
  const formats = data.columns.map((c) => widget.formats?.[c.name]);
  // the lowest and highest value of each column with a color scale, over the rows shown
  const ranges = useMemo(() => data.columns.map((c, i) => (widget.formats?.[c.name]?.scale ? columnRange(data.rows, i) : null)), [data, widget.formats]);
  return (
    <>
      <TableContainer sx={{ flex: 1, minHeight: 0 }}>
        <Table size="small" stickyHeader aria-label={widget.title ?? t("Table")} sx={DASH_TABLE_SX}>
          <TableHead>
            <TableRow>
              {data.columns.map((c, i) => (
                <TableCell key={c.name} align={numeric[i] ? "right" : "left"} title={c.name}>
                  {/* a related dataset's column is headed by its own name */}
                  {c.name.slice(c.name.lastIndexOf(".") + 1)}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {data.rows.map((row, r) => (
              <TableRow key={r}>
                {row.map((value, c) => {
                  const tint = cellTint(formats[c], value, ranges[c]);
                  return (
                    <TableCell key={c} align={numeric[c] ? "right" : "left"} sx={tint ? { bgcolor: tintBackground(tint) } : undefined}>
                      <Cell value={value} format={formats[c]?.number} locale={locale} />
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {data.total > data.rows.length && (
        <Typography sx={{ px: 1.5, py: 0.5, fontSize: 12, color: "text.secondary", flexShrink: 0 }}>
          {t("first {{rows}} of {{total}} rows", { rows: formatCount(data.rows.length), total: formatCount(data.total) })}
        </Typography>
      )}
    </>
  );
}

/**
 * The chart's style, with the formats of its measures where the style sets none: the first measure
 * on the left axis gives the left format, the first on the right axis the right one.
 */
function styleWithFormats(widget: ChartWidget, formats: Record<string, NumberFormat> | undefined): ChartStyle | undefined {
  const style = widget.style;
  const measures = drawnNames(widget);
  const left = measures.find((m) => style?.series?.[m]?.axis !== "right");
  const right = measures.find((m) => style?.series?.[m]?.axis === "right");
  const format = style?.format ?? (left === undefined ? undefined : formats?.[left]);
  const rightFormat = style?.right_format ?? (right === undefined ? undefined : formats?.[right]);
  if (format === style?.format && rightFormat === style?.right_format) return style;
  return { ...style, format, right_format: rightFormat };
}

function ChartView({
  widget,
  data,
  onPick,
  picked,
}: {
  widget: ChartWidget;
  data: Extract<WidgetData, { kind: "chart" }>;
  onPick?(value: PickValue | undefined): void;
  picked?: PickValue;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const height = useElementHeight(ref);
  const xType = data.columns.find((c) => c.name === widget.spec.x)?.type ?? "";
  const style = useMemo(() => styleWithFormats(widget, data.formats), [widget, data.formats]);
  // a counter over a measure or a value is captioned with its name
  const caption = widget.spec.kind === "counter" ? drawnNames(widget)[0] : undefined;
  if (widget.style?.look === "matrix") return <MatrixView widget={widget} data={data} onPick={onPick} picked={picked} />;
  return (
    <Box ref={ref} role="figure" aria-label={widget.title ?? t("Chart")} sx={{ flex: 1, minHeight: 0, overflow: "hidden", px: 1 }}>
      {height > 0 && <ChartCanvas data={data.data} spec={widget.spec} height={height} xType={xType} onPick={onPick} picked={picked} style={style} caption={caption} formats={widget.style?.format ? undefined : data.formats} />}
    </Box>
  );
}

function TextView({ widget }: { widget: TextWidget }) {
  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        overflow: "auto",
        px: 1.5,
        py: 0.5,
        "& > :first-child": { mt: 0.5 },
        "& h1, & h2, & h3": { mt: 1, mb: 0.5, letterSpacing: "-0.01em" },
        "& p": { my: 0.75, lineHeight: 1.6 },
        "& code": { fontFamily: MONO, fontSize: "0.85em", px: 0.5, borderRadius: 0.5, bgcolor: "action.hover" },
        "& a": { color: "primary.main" },
        "& table": { borderCollapse: "collapse" },
        "& td, & th": { border: 1, borderColor: "divider", px: 1, py: 0.25 },
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}>
        {widget.markdown}
      </ReactMarkdown>
    </Box>
  );
}

interface BodyProps {
  widget: Widget;
  data: WidgetData | undefined;
  loading: boolean;
  filterValue?: FilterValue;
  onFilterValue?(value: FilterValue | undefined): void;
  paramSpec?: ParamSpec;
  /** a chart's click on a category (given only to charts that cross-filter); undefined clears */
  onPick?(value: PickValue | undefined): void;
  /** the category picked in this chart (undefined: none) */
  picked?: PickValue;
}

/** What a widget draws from its data. The data comes from the kernel (it can be an error), and a chart or table has none until the first render. */
function Content({ widget, data, filterValue, onFilterValue, paramSpec, onPick, picked }: Omit<BodyProps, "loading">) {
  const { t } = useTranslation();
  if (widget.kind === "text") return <TextView widget={widget} />;
  const missing = widget.kind === "chart" ? chartMissing(widget) : null;
  if (missing) {
    return <Typography sx={{ m: "auto", p: 1.5, fontSize: 13, color: "text.secondary", textAlign: "center" }}>{t(missing)}</Typography>;
  }
  if (data?.kind === "error") {
    return (
      <Alert severity="error" variant="outlined" aria-label={t("Widget error")} sx={{ m: 1.5, py: 0, alignItems: "center", overflow: "auto" }}>
        {data.message}
      </Alert>
    );
  }
  if (widget.kind === "filter") {
    return (
      <Box sx={{ px: 1.5, py: 1 }}>
        <FilterControl filter={widget} options={data?.kind === "filter" ? data.options : []} paramSpec={paramSpec} value={filterValue} onChange={(v) => onFilterValue?.(v)} />
      </Box>
    );
  }
  if (!data) return null;
  if (widget.kind === "chart" && data.kind === "chart") return <ChartView widget={widget} data={data} onPick={onPick} picked={picked} />;
  if (widget.kind === "table" && data.kind === "table") return <TableView widget={widget} data={data} />;
  return <Typography sx={{ p: 1.5, fontSize: 12, color: "text.secondary" }}>{t("This widget has no data.")}</Typography>;
}

/**
 * One widget drawn from its data. While a render is under way the data it
 * replaces stays on screen under a thin progress bar; without any data yet a
 * placeholder stands in. Filters and text need no data to be drawn.
 */
export function WidgetBody({ widget, data, loading, filterValue, onFilterValue, paramSpec, onPick, picked }: BodyProps) {
  const { t } = useTranslation();
  const waiting = loading && widget.kind !== "text";
  const empty = !data && widget.kind !== "text" && widget.kind !== "filter";
  return (
    <Box sx={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {waiting && <LinearProgress aria-label={t("Loading")} sx={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 1 }} />}
      {empty && loading ? <Skeleton variant="rounded" sx={{ m: 1.5, flex: 1 }} /> : <Content widget={widget} data={data} filterValue={filterValue} onFilterValue={onFilterValue} paramSpec={paramSpec} onPick={onPick} picked={picked} />}
    </Box>
  );
}
