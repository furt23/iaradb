"use client";

import AutoFixHighOutlined from "@mui/icons-material/AutoFixHighOutlined";
import CalendarMonthOutlined from "@mui/icons-material/CalendarMonthOutlined";
import DeleteOutline from "@mui/icons-material/DeleteOutlineOutlined";
import ListAltOutlined from "@mui/icons-material/ListAltOutlined";
import TableChartOutlined from "@mui/icons-material/TableChartOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { ColumnInfo } from "@iara/protocol";
import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";

import type { ModelLayout } from "@/lib/dashboards/modelLayout";
import type { Dataset } from "@/lib/dashboards/types";
import { typeLabel } from "@/lib/format";
import type { ColumnRef, Relationship } from "@/lib/model/types";

import { CALENDAR_COLUMN_INFO } from "./calendarColumns";
import { typeGlyph } from "./fieldTree";
import { autoLayout, bodyHeight, cardHeight, CARD_WIDTH, columnY, dropTarget, HEADER_HEIGHT, linkEnds, linkPath, ROW_HEIGHT, withPlaces, type Point } from "./diagramLayout";
import { removeRelationship } from "./modelEdits";
import { RelationshipsDialog } from "./RelationshipsDialog";
import { columnsIn, useReadColumns, type FoundColumns } from "./useDatasetColumns";
import { useModel, useModelSource } from "./useModel";
import { useRelate } from "./useRelate";

/** how far an arrow key moves a table */
const KEY_STEP = 24;
/** room around the tables, so that one can be dragged past the edge */
const CANVAS_ROOM = 400;

interface Table {
  name: string;
  calendar: boolean;
  columns: ColumnInfo[];
}

const sameRef = (a: ColumnRef, dataset: string, column: string) => a.dataset === dataset && a.column === column;

/** One end's label on a line: which side of the relationship it is. */
function EndMark({ at, text, title }: { at: Point; text: string; title: string }) {
  return (
    <Box component="span" title={title} sx={{ position: "absolute", left: at.x - 9, top: at.y - 9, width: 18, height: 18, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, bgcolor: "background.paper", color: "text.secondary", border: 1, borderColor: "divider", pointerEvents: "none" }}>
      {text}
    </Box>
  );
}

/**
 * The model as tables on a canvas: drag a table by its title to place it (the places are saved with the dashboard),
 * and drag a column onto a column of another table to relate them. A click on a line selects it, to remove it.
 */
export function ModelDiagram({ slug, datasets, found, load, layout, onLayout }: { slug: string; datasets: Dataset[]; found: FoundColumns; load(name: string): Promise<ColumnInfo[]>; layout: ModelLayout; onLayout(layout: ModelLayout): void }) {
  const { t } = useTranslation();
  const model = useModel();
  const { source, setSource } = useModelSource();
  const { connect, busy } = useRelate(slug, datasets, found);
  useReadColumns(datasets, found, load);
  const canvas = useRef<HTMLDivElement>(null);
  const [dragged, setDragged] = useState<{ name: string; at: Point } | null>(null);
  // `over`: the column the drag would land on now. A pointer captured by the row it left fires no :hover on the others, so this draws it
  const [linking, setLinking] = useState<{ from: ColumnRef; at: Point; over: ColumnRef | null } | null>(null);
  const [scrolls, setScrolls] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<Relationship | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [listing, setListing] = useState(false);

  const tables = useMemo<Table[]>(
    () => [...datasets.map((d) => ({ name: d.name, calendar: false, columns: columnsIn(found, d.name) })), ...model.calendars.map((c) => ({ name: c.name, calendar: true, columns: CALENDAR_COLUMN_INFO }))],
    [datasets, found, model.calendars],
  );
  const rows = (name: string) => tables.find((x) => x.name === name)?.columns.length ?? 0;
  const places = useMemo(() => withPlaces(layout, tables.map((x) => x.name), model.relationships, (n) => tables.find((x) => x.name === n)?.columns.length ?? 0), [layout, tables, model.relationships]);
  const placeOf = (name: string): Point => (dragged?.name === name ? dragged.at : (places[name] ?? { x: 0, y: 0 }));
  const width = Math.max(0, ...tables.map((x) => placeOf(x.name).x)) + CARD_WIDTH + CANVAS_ROOM;
  const height = Math.max(0, ...tables.map((x) => placeOf(x.name).y + cardHeight(x.columns.length))) + CANVAS_ROOM;

  /** Where the pointer is on the canvas, which scrolls. */
  const onCanvas = (e: { clientX: number; clientY: number }): Point => {
    const box = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - box.left + canvas.current!.scrollLeft, y: e.clientY - box.top + canvas.current!.scrollTop };
  };

  const moved = (name: string, at: Point) => onLayout({ ...places, [name]: { x: Math.max(0, Math.round(at.x)), y: Math.max(0, Math.round(at.y)) } });

  const startMove = (e: PointerEvent<HTMLElement>, name: string) => {
    if (e.button !== 0) return;
    const start = onCanvas(e);
    const from = placeOf(name);
    const offset = { x: start.x - from.x, y: start.y - from.y };
    let last = from;
    e.currentTarget.setPointerCapture(e.pointerId);
    const target = e.currentTarget;
    const move = (m: globalThis.PointerEvent) => {
      const p = onCanvas(m);
      last = { x: Math.max(0, p.x - offset.x), y: Math.max(0, p.y - offset.y) };
      setDragged({ name, at: last });
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      setDragged(null);
      if (last !== from) moved(name, last);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  const moveByKey = (e: KeyboardEvent<HTMLElement>, name: string) => {
    const step = { ArrowLeft: [-KEY_STEP, 0], ArrowRight: [KEY_STEP, 0], ArrowUp: [0, -KEY_STEP], ArrowDown: [0, KEY_STEP] }[e.key];
    if (!step) return;
    e.preventDefault();
    const at = placeOf(name);
    moved(name, { x: at.x + step[0], y: at.y + step[1] });
  };

  const startLink = (e: PointerEvent<HTMLElement>, from: ColumnRef) => {
    if (e.button !== 0 || busy) return;
    e.preventDefault();
    setLinking({ from, at: onCanvas(e), over: null });
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const overAt = (m: { clientX: number; clientY: number }) => dropTarget(from, document.elementFromPoint(m.clientX, m.clientY)?.closest<HTMLElement>("[data-column]")?.dataset);
    const move = (m: globalThis.PointerEvent) => setLinking((l) => l && { ...l, at: onCanvas(m), over: overAt(m) });
    const stop = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", stop);
      setLinking(null);
    };
    const up = (m: globalThis.PointerEvent) => {
      stop();
      const to = overAt(m);
      if (!to) return;
      setProblem(null);
      void connect(from, to).then(setProblem);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", stop);
  };

  /** Where a column's line leaves its table, on that side. */
  const anchor = (ref: ColumnRef, side: "left" | "right"): Point => {
    const at = placeOf(ref.dataset);
    const index = tables.find((x) => x.name === ref.dataset)?.columns.findIndex((c) => c.name === ref.column) ?? -1;
    return { x: at.x + (side === "right" ? CARD_WIDTH : 0), y: columnY(at.y, rows(ref.dataset), Math.max(0, index), scrolls[ref.dataset]) };
  };

  /** The ends of a relationship's line, on the sides that face each other. */
  const lineOf = (r: Relationship) => {
    const sides = linkEnds(placeOf(r.many.dataset).x, placeOf(r.one.dataset).x);
    const from = anchor(r.many, sides.a);
    const to = anchor(r.one, sides.b);
    return { from, to, path: linkPath(from, sides.a, to, sides.b) };
  };

  /** The line being dragged: to the column it would land on, else to the pointer, out of the side nearest to it. */
  const dragLine = (l: NonNullable<typeof linking>): string => {
    if (l.over) {
      const sides = linkEnds(placeOf(l.from.dataset).x, placeOf(l.over.dataset).x);
      return linkPath(anchor(l.from, sides.a), sides.a, anchor(l.over, sides.b), sides.b);
    }
    const side = l.at.x >= placeOf(l.from.dataset).x + CARD_WIDTH / 2 ? "right" : "left";
    return linkPath(anchor(l.from, side), side, l.at, side === "right" ? "left" : "right");
  };

  const shown = model.relationships.filter((r) => tables.some((x) => x.name === r.many.dataset) && tables.some((x) => x.name === r.one.dataset));
  const inUse = (dataset: string, column: string) => shown.some((r) => sameRef(r.many, dataset, column) || sameRef(r.one, dataset, column));
  const removable = selected && selected.cast !== "date" ? selected : null;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, minWidth: 0 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, py: 1, borderBottom: 1, borderColor: "divider", flexShrink: 0, flexWrap: "wrap" }}>
        <Button size="small" variant="outlined" startIcon={<ListAltOutlined />} onClick={() => setListing(true)}>
          {t("Relationships")}
        </Button>
        <Button size="small" startIcon={<AutoFixHighOutlined />} onClick={() => onLayout(autoLayout(tables.map((x) => x.name), model.relationships, rows))}>
          {t("Arrange")}
        </Button>
        <Typography sx={{ fontSize: 12, color: "text.secondary", flex: 1, minWidth: 200 }}>{t("Drag a column onto a column of another table to relate them.")}</Typography>
        {removable && (
          <Button size="small" color="error" startIcon={<DeleteOutline />} onClick={() => {
            void setSource(removeRelationship(source, removable));
            setSelected(null);
          }}>
            {t("Remove")} {removable.many.dataset} → {removable.one.dataset}
          </Button>
        )}
      </Box>
      {busy && <LinearProgress aria-label={t("Loading")} sx={{ flexShrink: 0 }} />}
      {problem && (
        <Alert severity="error" onClose={() => setProblem(null)} sx={{ borderRadius: 0, flexShrink: 0 }}>
          {problem}
        </Alert>
      )}
      <Box
        ref={canvas}
        role="application"
        aria-label={t("Model diagram")}
        onClick={(e) => e.target === e.currentTarget && setSelected(null)}
        sx={{ flex: 1, minHeight: 0, overflow: "auto", position: "relative", bgcolor: "background.default" }}
      >
        <Box onClick={(e) => e.target === e.currentTarget && setSelected(null)} sx={{ position: "relative", width, height, minWidth: "100%", minHeight: "100%" }}>
          {!tables.length && <Typography sx={{ p: 4, textAlign: "center", color: "text.secondary" }}>{t("No datasets yet")}</Typography>}
          <Box component="svg" aria-hidden sx={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
            {shown.map((r) => {
              const on = selected?.span.from === r.span.from && selected.many.dataset === r.many.dataset && selected.one.dataset === r.one.dataset;
              const { path } = lineOf(r);
              return (
                <g key={`${r.many.dataset}.${r.many.column}>${r.one.dataset}.${r.one.column}`}>
                  {/* a wider line that takes the click */}
                  <path d={path} fill="none" stroke="transparent" strokeWidth={14} style={{ pointerEvents: "stroke", cursor: "pointer" }} onClick={() => setSelected(r)} />
                  <Box component="path" d={path} fill="none" sx={{ stroke: (theme) => (on ? theme.palette.primary.main : theme.palette.text.secondary), strokeWidth: on ? 2.5 : 1.5, ...(r.cast === "date" && { strokeDasharray: "5 4" }) }} />
                </g>
              );
            })}
          </Box>
          {tables.map((x) => {
            const at = placeOf(x.name);
            // while a column is dragged: where it can land stands out, what it cannot fades, and the table under the pointer is marked
            const landable = !!linking && !x.calendar && x.name !== linking.from.dataset;
            const landing = linking?.over?.dataset === x.name;
            return (
              <Paper
                key={x.name}
                variant="outlined"
                aria-label={x.name}
                component="section"
                sx={{
                  position: "absolute",
                  left: at.x,
                  top: at.y,
                  width: CARD_WIDTH,
                  overflow: "hidden",
                  zIndex: dragged?.name === x.name ? 2 : 1,
                  boxShadow: dragged?.name === x.name ? 6 : 1,
                  ...(landable && { outline: landing ? 2 : 1, outlineStyle: landing ? "solid" : "dashed", outlineColor: "primary.main", outlineOffset: 1 }),
                  ...(linking && !landable && x.name !== linking.from.dataset && { opacity: 0.45 }),
                }}
              >
                <Tooltip title={t("Drag to move it. Arrow keys also move it.")} enterDelay={800}>
                  <Box
                    tabIndex={0}
                    role="button"
                    aria-label={`${t("Move")} ${x.name}`}
                    onPointerDown={(e) => startMove(e, x.name)}
                    onKeyDown={(e) => moveByKey(e, x.name)}
                    sx={{ height: HEADER_HEIGHT, display: "flex", alignItems: "center", gap: 0.75, px: 1, cursor: "move", touchAction: "none", userSelect: "none", bgcolor: "action.selected", borderBottom: 1, borderColor: "divider" }}
                  >
                    {x.calendar ? <CalendarMonthOutlined sx={{ fontSize: 16, color: "text.secondary" }} /> : <TableChartOutlined sx={{ fontSize: 16, color: "text.secondary" }} />}
                    <Typography noWrap sx={{ fontSize: 13, fontWeight: 650 }}>
                      {x.name}
                    </Typography>
                  </Box>
                </Tooltip>
                <Box
                  onScroll={(e) => {
                    const top = e.currentTarget.scrollTop;
                    setScrolls((s) => ({ ...s, [x.name]: top }));
                  }}
                  sx={{ height: bodyHeight(x.columns.length), overflowY: "auto" }}
                >
                  {x.columns.map((c) => {
                    const related = inUse(x.name, c.name);
                    const lit = !!linking && ((linking.over?.dataset === x.name && linking.over.column === c.name) || sameRef(linking.from, x.name, c.name));
                    return (
                      <Box
                        key={c.name}
                        data-column={c.name}
                        data-table={x.name}
                        {...(x.calendar && { "data-calendar": "true" })}
                        onPointerDown={x.calendar ? undefined : (e) => startLink(e, { dataset: x.name, column: c.name })}
                        title={`${c.name} · ${typeLabel(c.type)}`}
                        sx={{ height: ROW_HEIGHT, display: "flex", alignItems: "center", gap: 0.5, px: 1, fontSize: 12.5, cursor: x.calendar ? "default" : "crosshair", touchAction: "none", userSelect: "none", color: lit ? "primary.contrastText" : related ? "primary.main" : "text.primary", bgcolor: lit ? "primary.main" : undefined, fontWeight: lit || related ? 650 : 400, "&:hover": lit ? undefined : { bgcolor: "action.hover" } }}
                      >
                        <Box component="span" sx={{ fontFamily: "var(--font-mono, monospace)", fontSize: 10, minWidth: 22, color: "text.disabled", flexShrink: 0 }}>
                          {typeGlyph(c.type)}
                        </Box>
                        <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {c.name}
                        </Box>
                      </Box>
                    );
                  })}
                </Box>
              </Paper>
            );
          })}
          {/* above the tables, where a line meets them */}
          <Box sx={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 3 }}>
            {shown.flatMap((r) => {
              const { from, to } = lineOf(r);
              const key = `${r.many.dataset}.${r.many.column}>${r.one.dataset}.${r.one.column}`;
              return [<EndMark key={`${key}:n`} at={from} text="N" title={t("Many rows")} />, <EndMark key={`${key}:1`} at={to} text="1" title={t("One row")} />];
            })}
          </Box>
          {/* above the tables: the line must not go behind the one it is heading for */}
          {linking && (
            <Box component="svg" aria-hidden sx={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 5 }}>
              <Box component="path" d={dragLine(linking)} fill="none" sx={{ stroke: (theme) => theme.palette.primary.main, strokeWidth: 2, strokeDasharray: linking.over ? undefined : "6 4" }} />
            </Box>
          )}
          {linking?.over && (
            <Paper elevation={4} sx={{ position: "absolute", left: linking.at.x + 14, top: linking.at.y + 14, zIndex: 6, px: 1, py: 0.5, pointerEvents: "none", whiteSpace: "nowrap", fontSize: 12 }}>
              {t("Drop to relate {{from}} and {{to}}", { from: linking.from.column, to: linking.over.column })}
            </Paper>
          )}
          {removable && (
            <Box sx={{ position: "absolute", zIndex: 4, ...(() => {
              const { from, to } = lineOf(removable);
              return { left: (from.x + to.x) / 2 - 15, top: (from.y + to.y) / 2 - 15 };
            })() }}>
              <IconButton size="small" aria-label={`${t("Remove")} ${removable.many.dataset} → ${removable.one.dataset}`} onClick={() => {
                void setSource(removeRelationship(source, removable));
                setSelected(null);
              }} sx={{ bgcolor: "background.paper", border: 1, borderColor: "divider", "&:hover": { bgcolor: "background.paper", color: "error.main" } }}>
                <DeleteOutline fontSize="small" />
              </IconButton>
            </Box>
          )}
        </Box>
      </Box>
      <RelationshipsDialog open={listing} slug={slug} focus={[]} datasets={datasets} found={found} load={load} onClose={() => setListing(false)} />
    </Box>
  );
}
