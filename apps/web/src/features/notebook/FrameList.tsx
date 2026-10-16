"use client";

import ChevronRight from "@mui/icons-material/ChevronRight";
import ExpandMore from "@mui/icons-material/ExpandMore";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import type { FrameInfo } from "@iara/protocol";
import { useState } from "react";

import { useTranslation } from "@/i18n";
import { formatCount, typeLabel } from "@/lib/format";

const MONO = "'JetBrains Mono Variable', monospace";

/** "1,000 rows × 3 columns", or "3 columns" for a LazyFrame (it is not run). */
export function frameShape(f: FrameInfo): string {
  const cols = `${f.columns.length} column${f.columns.length === 1 ? "" : "s"}`;
  return f.rows === null ? cols : `${formatCount(f.rows)} row${f.rows === 1 ? "" : "s"} × ${cols}`;
}

function Frame({ frame }: { frame: FrameInfo }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const inline = frame.columns.map((c) => `${c.name}: ${typeLabel(c.type)}`).join(", ");
  return (
    <Box>
      <ButtonBase
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        sx={{ width: "100%", justifyContent: "flex-start", gap: 0.75, px: 1, py: 0.4, fontSize: 12, fontFamily: MONO, color: "text.secondary", "&:hover": { color: "text.primary" } }}
      >
        {open ? <ExpandMore sx={{ fontSize: 16 }} /> : <ChevronRight sx={{ fontSize: 16 }} />}
        <Box component="span" sx={{ color: "text.primary", fontWeight: 600, flexShrink: 0 }}>
          {frame.name ?? "result"}
        </Box>
        <Box component="span" sx={{ flexShrink: 0 }}>
          {frame.kind} · {frameShape(frame)}
        </Box>
        {!open && (
          <Box component="span" sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "text.disabled" }}>
            [{inline}]
          </Box>
        )}
      </ButtonBase>
      {open && (
        <Box
          role="list"
          aria-label={t("columns of {{name}}", { name: frame.name ?? "result" })}
          sx={{ display: "grid", gridTemplateColumns: "max-content 1fr", columnGap: 2, rowGap: 0.25, pl: 4.5, pr: 1, pb: 0.75, maxHeight: 260, overflow: "auto", fontSize: 12 }}
        >
          {frame.columns.map((c) => (
            <Box key={c.name} role="listitem" sx={{ display: "contents" }}>
              <Box sx={{ fontFamily: MONO, color: "text.primary" }}>{c.name}</Box>
              <Box title={c.type} sx={{ color: "text.secondary" }}>
                {typeLabel(c.type)}
              </Box>
            </Box>
          ))}
          {frame.kind === "LazyFrame" && (
            <Box sx={{ gridColumn: "1 / -1", color: "text.disabled", pt: 0.5 }}>{t("Not run yet: .preview() shows its first rows")}</Box>
          )}
        </Box>
      )}
    </Box>
  );
}

/** The frames a cell made, one line each, expanding to their columns and types. */
export function FrameList({ frames }: { frames: FrameInfo[] }) {
  const { t } = useTranslation();
  if (!frames.length) return null;
  return (
    <Box aria-label={t("frames")} sx={{ py: 0.25 }}>
      {frames.map((f, i) => (
        <Frame key={f.name ?? `result-${i}`} frame={f} />
      ))}
    </Box>
  );
}
