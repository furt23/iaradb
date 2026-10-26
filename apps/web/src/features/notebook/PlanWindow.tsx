"use client";

import CloseRounded from "@mui/icons-material/CloseRounded";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Portal from "@mui/material/Portal";
import Typography from "@mui/material/Typography";
import type { QueryAnalysis } from "@iara/protocol";
import { type PointerEvent, useEffect, useRef, useState } from "react";

import { QueryProfile } from "@/features/analyze/QueryProfile";
import { useTranslation } from "@/i18n";
import { formatBytes, formatCompact, formatCount, formatDuration } from "@/lib/format";

import { initialWindow, keepInside, MIN_WINDOW_SIZE, type Point, shownQuery, type Viewport } from "./planWindowRules";

interface Props {
  /** the queries of the cell's last run, oldest first */
  queries: QueryAnalysis[];
  /** what it opens on: a query (else the latest) and one of its pipelines (else its whole plan) */
  opening?: { query: number; pipeline?: number };
  onClose(): void;
}

interface Drag {
  x: number;
  y: number;
  left: number;
  top: number;
}

function viewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * A cell's query plans in a window that floats over the notebook, which stays usable: drag it by
 * its title bar, resize it from its corner. Esc closes it.
 */
export function PlanWindow({ queries, opening, onClose }: Props) {
  const { t } = useTranslation();
  const paper = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [start] = useState(() => initialWindow(viewport()));
  const [pos, setPos] = useState<Point>(start);
  const [picked, setPicked] = useState<number | null>(opening?.query ?? null);

  // a browser window resize keeps this one on screen
  useEffect(() => {
    const onResize = () => {
      const el = paper.current;
      if (el) setPos((p) => keepInside(p, { width: el.offsetWidth, height: el.offsetHeight }, viewport()));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onTitleDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, left: pos.left, top: pos.top };
  };
  const onTitleMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = paper.current;
    if (!d || !el) return;
    const at = { left: d.left + e.clientX - d.x, top: d.top + e.clientY - d.y };
    setPos(keepInside(at, { width: el.offsetWidth, height: el.offsetHeight }, viewport()));
  };
  const onTitleUp = () => {
    drag.current = null;
  };

  const index = shownQuery(picked, queries.length);
  const q = queries[index];
  const summary = [t("{{time}} total", { time: formatDuration(q.profile.elapsed_ms) }), t("{{rows}} rows", { rows: formatCount(q.rows) })];
  if (q.profile.memory_peak != null) summary.push(t("{{memory}} peak memory", { memory: formatBytes(q.profile.memory_peak) }));

  return (
    <Portal>
      <Paper
        ref={paper}
        role="dialog"
        aria-label={t("Query plan")}
        elevation={8}
        style={{ left: pos.left, top: pos.top, width: start.width, height: start.height }}
        sx={{
          position: "fixed",
          // above the app bar, under dialogs and menus
          zIndex: (theme) => theme.zIndex.drawer,
          display: "flex",
          flexDirection: "column",
          minWidth: MIN_WINDOW_SIZE.width,
          minHeight: MIN_WINDOW_SIZE.height,
          resize: "both",
          overflow: "hidden",
        }}
      >
        <Box
          onPointerDown={onTitleDown}
          onPointerMove={onTitleMove}
          onPointerUp={onTitleUp}
          onPointerCancel={onTitleUp}
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            pl: 2,
            pr: 1,
            height: 40,
            flexShrink: 0,
            borderBottom: 1,
            borderColor: "divider",
            cursor: "grab",
            userSelect: "none",
            touchAction: "none",
            "&:active": { cursor: "grabbing" },
          }}
        >
          <Typography variant="subtitle2" sx={{ fontWeight: 650 }}>
            {t("Query plan")}
          </Typography>
          <IconButton size="small" onClick={onClose} aria-label={t("close")} sx={{ ml: "auto" }}>
            <CloseRounded fontSize="small" />
          </IconButton>
        </Box>
        <Typography variant="caption" sx={{ color: "text.secondary", px: 2, py: 1, flexShrink: 0 }}>
          {summary.join(" · ")}
        </Typography>
        {queries.length > 1 && (
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75, px: 2, pb: 1, flexShrink: 0, borderBottom: 1, borderColor: "divider" }}>
            {queries.map((query, i) => (
              <Chip
                key={i}
                size="small"
                label={`${t("Query {{n}}", { n: i + 1 })} · ${formatDuration(query.profile.elapsed_ms)} · ${t("{{rows}} rows", { rows: formatCompact(query.rows) })}`}
                onClick={() => setPicked(i)}
                aria-pressed={i === index}
                color={i === index ? "secondary" : "default"}
                variant={i === index ? "filled" : "outlined"}
              />
            ))}
          </Box>
        )}
        {/* keyed: another query starts on its whole plan */}
        <QueryProfile key={index} analysis={q} pipeline={index === opening?.query ? opening.pipeline : undefined} />
      </Paper>
    </Portal>
  );
}
