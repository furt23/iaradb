"use client";

import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import { useEffect, useRef } from "react";

import { CodeEditor } from "@/features/editor/CodeEditor";
import { ReviewBar } from "@/features/iara/ReviewBar";
import { useTranslation } from "@/i18n";

import type { NotebookReview } from "./iaraBridge";

/** A cell Iara proposes to add, shown where it would go until the user keeps or undoes it; it is not in the notebook yet. */
export function IaraNewCell({ review, canRun, schema }: { review: NotebookReview; canRun: boolean; schema: Record<string, { name: string }[]> }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);
  const keep = () => review.decide.keep(canRun);
  return (
    <Paper ref={ref} variant="outlined" sx={{ mb: 1, overflow: "hidden", borderLeft: 3, borderLeftColor: "secondary.main", borderStyle: "dashed" }}>
      <Typography variant="overline" sx={{ display: "block", px: 1.5, color: "text.secondary", lineHeight: 2 }}>
        {t("New {{kind}} cell", { kind: review.kind })}
      </Typography>
      <Box sx={{ borderTop: 1, borderColor: "divider" }}>
        <ReviewBar decide={review.decide} canRun={canRun} />
        <CodeEditor value={review.code} onChange={review.setCode} language={review.kind} schema={review.kind === "sql" ? schema : undefined} onRun={keep} onRunInPlace={keep} />
      </Box>
    </Paper>
  );
}
