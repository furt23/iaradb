"use client";

import InsightsOutlined from "@mui/icons-material/InsightsOutlined";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";

import { useAnalyze } from "./useAnalyze";

/** Profiles a query from a list row (the row's own click, which opens the query, is left alone). */
export function AnalyzeIconButton({ query, source }: { query: string; source?: string }) {
  const { analyze, pending } = useAnalyze();
  return (
    <Tooltip title="Analyze">
      <span>
        <IconButton
          size="small"
          aria-label="analyze query"
          disabled={pending}
          onClick={(e) => {
            e.stopPropagation();
            void analyze(query, source);
          }}
        >
          <InsightsOutlined fontSize="small" />
        </IconButton>
      </span>
    </Tooltip>
  );
}
