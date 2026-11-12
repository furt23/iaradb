"use client";

import Add from "@mui/icons-material/Add";
import CloseOutlined from "@mui/icons-material/CloseOutlined";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Popover from "@mui/material/Popover";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { ColumnInfo } from "@iara/protocol";
import { useState, type DragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { asValues, valueName } from "@/lib/dashboards/chartFields";
import type { ChartSort, ChartWidget, Dataset, ValueAgg, ValueField } from "@/lib/dashboards/types";
import { isNumericType, typeLabel } from "@/lib/format";

import { carriesField, FIELD_MIME, parseField, type FieldRef } from "../canvas/fieldDrag";
import { CALENDAR_COLUMN_INFO } from "./calendarColumns";
import { addRowCount, addValue, fieldName, removeValue, setGroup, setX, type Word } from "./fieldActions";
import type { Picked } from "./fieldChoices";
import { FieldPicker } from "./FieldPicker";
import { typeGlyph } from "./fieldTree";
import { withMeasure, withoutMeasure } from "./measureWidgets";
import { NumberFormatFields } from "./NumberFormatFields";
import { PANEL_HEADING } from "./panelStyle";
import { columnsIn, type FoundColumns } from "./useDatasetColumns";
import { useModel } from "./useModel";

/** a field on the chart: as wide as its well, with near-square corners, so it reads as a block and not as a tag */
const SLOT = { width: "100%", minHeight: 36, borderRadius: "4px", border: 1, borderColor: "divider" };
/** what a field is, by the color of its mark: a measure, a value of the chart, a column */
const TONES = {
  measure: { bgcolor: "primary.main", color: "primary.contrastText" },
  value: { bgcolor: "success.main", color: "success.contrastText" },
  column: { bgcolor: "action.hover", color: "text.secondary" },
} as const;
const NUMBER_AGGS: { agg: ValueAgg; label: string }[] = [
  { agg: "sum", label: "Sum" },
  { agg: "avg", label: "Average" },
  { agg: "min", label: "Min" },
  { agg: "max", label: "Max" },
  { agg: "count", label: "Count" },
  { agg: "count_distinct", label: "Distinct count" },
];
const OTHER_AGGS = NUMBER_AGGS.filter((a) => a.agg !== "sum" && a.agg !== "avg");
const SORTS: { sort: ChartSort; label: string }[] = [
  { sort: "value", label: "Largest value first" },
  { sort: "value_asc", label: "Smallest value first" },
  { sort: "x", label: "Name, A to Z" },
  { sort: "x_desc", label: "Name, Z to A" },
];

interface Source {
  name: string;
  columns: ColumnInfo[];
}

/** A place on the chart a field can be dropped on. */
function Well({ label, onField, children }: { label: string; onField(field: FieldRef): void; children: ReactNode }) {
  const [over, setOver] = useState(false);
  return (
    <Stack
      role="group"
      aria-label={label}
      spacing={0.75}
      onDragOver={(e: DragEvent<HTMLElement>) => {
        if (!carriesField(e.dataTransfer.types)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={(e: DragEvent<HTMLElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e: DragEvent<HTMLElement>) => {
        setOver(false);
        const field = parseField(e.dataTransfer.getData(FIELD_MIME));
        if (!field) return;
        // the frame around the chart would take it too
        e.preventDefault();
        e.stopPropagation();
        onField(field);
      }}
      sx={{ borderRadius: "4px", outline: over ? 2 : 0, outlineStyle: "dashed", outlineColor: "primary.main", outlineOffset: 3 }}
    >
      <Typography sx={PANEL_HEADING}>{label}</Typography>
      {children}
    </Stack>
  );
}

/** A field on the chart: a click opens what can be changed about it, the cross takes it off. `tone`: the color of its mark says what it is. */
function Slot({ glyph, glyphTitle, tone, title, caption, onOpen, removeLabel, onRemove }: { glyph: string; glyphTitle?: string; tone: keyof typeof TONES; title: string; caption?: string; onOpen(anchor: HTMLElement): void; removeLabel: string; onRemove(): void }) {
  return (
    <Box sx={{ ...SLOT, display: "flex", alignItems: "center", bgcolor: "action.selected", minWidth: 0, "& .slot-remove": { opacity: 0.55 }, "&:hover .slot-remove, & .slot-remove:focus-visible": { opacity: 1 } }}>
      <ButtonBase onClick={(e) => onOpen(e.currentTarget)} sx={{ flex: 1, minWidth: 0, alignSelf: "stretch", display: "flex", justifyContent: "flex-start", gap: 1, px: 0.75, py: 0.5, textAlign: "left", borderRadius: "4px" }}>
        <Box role="img" aria-label={glyphTitle} title={glyphTitle} sx={{ ...TONES[tone], width: 26, height: 26, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "3px", fontFamily: "var(--font-mono, monospace)", fontSize: 11, fontWeight: 650 }}>
          {glyph}
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography noWrap title={title} sx={{ fontSize: 13, lineHeight: 1.3, fontWeight: 550, color: "text.primary" }}>
            {title}
          </Typography>
          {caption && (
            <Typography noWrap title={caption} sx={{ fontSize: 11, lineHeight: 1.3, color: "text.secondary" }}>
              {caption}
            </Typography>
          )}
        </Box>
      </ButtonBase>
      <IconButton className="slot-remove" size="small" aria-label={removeLabel} onClick={onRemove} sx={{ mr: 0.25, flexShrink: 0 }}>
        <CloseOutlined sx={{ fontSize: 16 }} />
      </IconButton>
    </Box>
  );
}

/** An action, in the accent color: a click lists the fields that can go here, and one can be dragged here. */
function EmptySlot({ label, onOpen }: { label: string; onOpen(anchor: HTMLElement): void }) {
  return (
    <ButtonBase onClick={(e) => onOpen(e.currentTarget)} sx={{ ...SLOT, borderStyle: "dashed", borderColor: "primary.main", display: "flex", justifyContent: "flex-start", gap: 0.5, px: 1, fontSize: 13, fontWeight: 550, color: "primary.main", "&:hover": { bgcolor: "action.hover" } }}>
      <Add sx={{ fontSize: 16 }} />
      {label}
    </ButtonBase>
  );
}

/** A value on the chart; a click opens its name, its aggregation and its number format. */
function ValueSlot({ value, numeric, onChange, onRemove }: { value: ValueField; numeric: boolean; onChange(value: ValueField): void; onRemove(): void }) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  // the name is a column of the query: it changes when typing ends
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const next = draft?.trim().replaceAll(":", " ");
    if (next && next !== value.name) onChange({ ...value, name: next });
    setDraft(null);
  };
  const aggs = numeric ? NUMBER_AGGS : OTHER_AGGS;
  const agg = NUMBER_AGGS.find((a) => a.agg === value.agg);
  const source = `${value.dataset}${value.column ? `.${value.column}` : ""}`;
  return (
    <>
      <Slot
        glyph={value.column ? "Σ" : "#"}
        tone="value"
        title={value.name}
        caption={value.column ? `${agg ? t(agg.label) : ""} · ${source}` : source}
        onOpen={setAnchor}
        removeLabel={`${t("Remove")} ${value.name}`}
        onRemove={onRemove}
      />
      <Popover open={anchor !== null} anchorEl={anchor} onClose={() => { commit(); setAnchor(null); }} anchorOrigin={{ vertical: "bottom", horizontal: "left" }}>
        <Stack spacing={1.5} sx={{ p: 2, width: 280 }}>
          <TextField size="small" fullWidth label={t("Value name")} value={draft ?? value.name} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
          {value.column !== undefined && (
            <TextField select size="small" fullWidth label={t("Aggregation")} value={value.agg} onChange={(e) => onChange({ ...value, agg: e.target.value as ValueAgg })}>
              {aggs.map((a) => (
                <MenuItem key={a.agg} value={a.agg}>
                  {t(a.label)}
                </MenuItem>
              ))}
            </TextField>
          )}
          <NumberFormatFields
            label={t("Number format")}
            value={value.format}
            onChange={(format) => {
              const { format: _old, ...bare } = value;
              onChange(format ? { ...bare, format } : bare);
            }}
          />
        </Stack>
      </Popover>
    </>
  );
}

/**
 * What a chart draws: the x axis, the legend and the values, each filled from any dataset, by dragging a field from
 * the Fields pane or picking it from the well's list. A numeric column comes in summed, anything else counted.
 * `onMeasure`: a measure's chip was clicked, to edit it where measures are edited.
 */
export function FieldWells({ widget, datasets, found, onChange, onMeasure }: { widget: ChartWidget; datasets: Dataset[]; found: FoundColumns; onChange(widget: ChartWidget): void; onMeasure?(name: string): void }) {
  const { t } = useTranslation();
  const model = useModel();
  const word: Word = (key, vars) => t(key, vars);
  const chart = asValues(widget, word);
  const { kind, x, group } = chart.spec;
  const counter = kind === "counter";
  const [list, setList] = useState<{ well: "x" | "group" | "values"; anchor: HTMLElement } | null>(null);
  const open = (well: "x" | "group" | "values") => (anchor: HTMLElement) => setList({ well, anchor });

  /** Every dataset's columns, and the calendars': a chart reads across them through the relationships. */
  const sources: Source[] = [
    ...datasets.map((d) => ({ name: d.name, columns: columnsIn(found, d.name) })),
    ...model.calendars.map((c) => ({ name: c.name, columns: CALENDAR_COLUMN_INFO })),
  ];

  /** A column named as the chart names it, as a slot shows it: its own name, its dataset under it, its type's mark. */
  const axisSlot = (text: string, well: "x" | "group", onRemove: () => void) => {
    const dotted = sources.find((s) => text.startsWith(`${s.name}.`));
    const dataset = dotted?.name ?? chart.dataset;
    const column = dotted ? text.slice(dotted.name.length + 1) : text;
    const type = sources.find((s) => s.name === dataset)?.columns.find((c) => c.name === column)?.type;
    return <Slot glyph={type ? typeGlyph(type) : "?"} glyphTitle={type && typeLabel(type)} tone="column" title={column} caption={dataset} onOpen={open(well)} removeLabel={`${t("Remove")} ${column}`} onRemove={onRemove} />;
  };

  const put = (field: FieldRef, place: (name: string) => ChartWidget) => field.kind === "column" && onChange(place(fieldName(chart, field)));
  const toValues = (picked: Picked) => {
    if (picked.kind === "rows") return onChange(addRowCount(chart, picked.dataset, word));
    onChange(picked.kind === "measure" ? withMeasure(chart, picked.name, word) : addValue(chart, picked, word));
  };
  const onPick = (picked: Picked) => {
    if (list?.well === "values") return toValues(picked);
    if (picked.kind !== "column") return;
    onChange(list?.well === "x" ? setX(chart, fieldName(chart, picked), word) : setGroup(chart, fieldName(chart, picked), word));
  };
  // a name still the automatic one follows the aggregation
  const keepName = (next: ValueField, old: ValueField): ValueField => (next.agg !== old.agg && old.name === valueName(old.agg, old.column, word) ? { ...next, name: valueName(next.agg, next.column, word) } : next);

  return (
    <Stack spacing={2}>
      {!counter && (
        <Well label={t("X axis")} onField={(f) => put(f, (name) => setX(chart, name, word))}>
          {x ? axisSlot(x, "x", () => onChange(setX(chart, "", word))) : <EmptySlot label={t("Add column")} onOpen={open("x")} />}
        </Well>
      )}
      {!counter && kind !== "pie" && (
        <Well label={t("Legend")} onField={(f) => put(f, (name) => setGroup(chart, name, word))}>
          {group ? axisSlot(group, "group", () => onChange(setGroup(chart, null, word))) : <EmptySlot label={t("Add column")} onOpen={open("group")} />}
        </Well>
      )}
      <Well label={t("Values")} onField={toValues}>
        {(chart.measures ?? []).map((m) => (
          <Slot key={m} glyph="ƒx" glyphTitle={t("Measure")} tone="measure" title={m} caption={model.measures.find((x2) => x2.name === m)?.datasets.join(", ")} onOpen={() => onMeasure?.(m)} removeLabel={`${t("Remove")} ${m}`} onRemove={() => onChange(withoutMeasure(chart, m))} />
        ))}
        {(chart.values ?? []).map((v, i) => (
          <ValueSlot
            // by place: a rename must not close what is being edited
            key={i}
            value={v}
            numeric={isNumericType(sources.find((s) => s.name === v.dataset)?.columns.find((c) => c.name === v.column)?.type ?? "")}
            onChange={(next) => onChange({ ...chart, values: chart.values!.map((o) => (o === v ? keepName(next, v) : o)) })}
            onRemove={() => onChange(removeValue(chart, v.name))}
          />
        ))}
        <EmptySlot label={t("Add value")} onOpen={open("values")} />
      </Well>
      <FieldPicker anchor={list?.anchor ?? null} datasets={datasets} found={found} values={list?.well === "values"} onPick={onPick} onClose={() => setList(null)} />
      {(kind === "bar" || kind === "pie") && (
        <Box sx={{ display: "flex", gap: 1 }}>
          <TextField select size="small" fullWidth label={t("Sort")} value={chart.sort ?? "value"} onChange={(e) => onChange({ ...chart, sort: e.target.value as ChartSort })}>
            {SORTS.map((s) => (
              <MenuItem key={s.sort} value={s.sort}>
                {t(s.label)}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            type="number"
            label={t("Show top")}
            placeholder={t("All")}
            value={chart.top ?? ""}
            onChange={(e) => {
              const n = Number(e.target.value);
              const { top: _top, ...bare } = chart;
              onChange(Number.isInteger(n) && n >= 1 && n <= 1000 ? { ...bare, top: n } : bare);
            }}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: 1, max: 1000 } }}
            sx={{ width: 110, flexShrink: 0 }}
          />
        </Box>
      )}
    </Stack>
  );
}
