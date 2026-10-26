"use client";

import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import type { AnalyzedNode, QueryAnalysis } from "@iara/protocol";
import { useMemo, useState } from "react";

import { formatCompact, formatDuration } from "@/lib/format";

import { NodeDetail } from "./NodeDetail";
import { PipelineGraph } from "./PipelineGraph";
import { PlanGraph } from "./PlanGraph";
import { planNodes } from "./metrics";
import { sinkName, sourceLabel } from "./pipelines";

/** the whole plan, its text, or one pipeline (by index) */
type View = "plan" | "text" | number;

interface ItemProps {
  selected: boolean;
  onClick(): void;
  title: string;
  /** a pipeline's number */
  index?: number;
  meta?: string;
  ms?: number;
  /** of the time all pipelines took, 0..1 */
  share?: number;
}

function Item({ selected, onClick, title, index, meta, ms, share }: ItemProps) {
  return (
    <ButtonBase
      onClick={onClick}
      aria-current={selected || undefined}
      sx={{
        display: "grid",
        gridTemplateColumns: "22px minmax(0, 1fr) auto",
        columnGap: 1,
        alignItems: "baseline",
        width: "100%",
        textAlign: "left",
        px: 1.5,
        py: 0.75,
        borderLeft: 2,
        borderColor: selected ? "primary.main" : "transparent",
        bgcolor: selected ? "action.selected" : undefined,
        "&:hover": { bgcolor: selected ? "action.selected" : "action.hover" },
      }}
    >
      <Typography variant="mono" sx={{ fontSize: 11, color: "text.disabled" }}>
        {index ?? ""}
      </Typography>
      <Typography variant="body2" sx={{ fontWeight: selected ? 650 : 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={title}>
        {title}
      </Typography>
      <Typography variant="mono" sx={{ fontSize: 11, color: "text.secondary" }}>
        {ms == null ? "" : formatDuration(ms)}
      </Typography>
      {meta && (
        <Typography variant="mono" sx={{ gridColumn: 2, fontSize: 10.5, color: "text.secondary", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {meta}
        </Typography>
      )}
      {share != null && (
        <Box sx={{ gridColumn: "2 / 4", mt: 0.5, height: 3, borderRadius: 2, bgcolor: "action.hover", overflow: "hidden" }}>
          <Box sx={{ width: `${Math.round(share * 100)}%`, height: "100%", bgcolor: "primary.main" }} />
        </Box>
      )}
    </ButtonBase>
  );
}

interface Props {
  analysis: Pick<QueryAnalysis, "plan" | "profile" | "text">;
  /** the pipeline it opens on (else the whole plan) */
  pipeline?: number;
}

/**
 * A query run as Spark's SQL tab shows one: its pipelines in run order with
 * their times on the left, the graph of the whole plan or of the pipeline picked
 * beside them, and the operator clicked in a panel on the right. Fills its parent.
 */
export function QueryProfile({ analysis, pipeline }: Props) {
  const nodes = useMemo(() => planNodes(analysis.plan), [analysis.plan]);
  const [view, setView] = useState<View>(pipeline != null && pipeline < analysis.profile.pipelines.length ? pipeline : "plan");
  const [node, setNode] = useState<AnalyzedNode | null>(null);
  const totalMs = analysis.profile.elapsed_ms;
  const pipelines = analysis.profile.pipelines;
  const pipelinesMs = pipelines.reduce((a, p) => a + p.elapsed_ms, 0);

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: "grid",
        gridTemplateColumns: node ? "260px minmax(0, 1fr) 300px" : "260px minmax(0, 1fr)",
        gridTemplateRows: "minmax(0, 1fr)",
      }}
    >
      <Box component="nav" sx={{ overflowY: "auto", borderRight: 1, borderColor: "divider", py: 0.5 }}>
        <Item selected={view === "plan"} onClick={() => setView("plan")} title="Full plan" meta={`${nodes.length} operators`} ms={totalMs} />
        <Typography variant="overline" sx={{ display: "block", px: 1.5, pt: 1, color: "text.disabled", lineHeight: 2 }}>
          Pipelines
        </Typography>
        {pipelines.map((p, i) => (
          <Item
            key={i}
            selected={view === i}
            onClick={() => setView(i)}
            index={i + 1}
            title={`${sourceLabel(p, nodes)} → ${sinkName(p.sink)}`}
            meta={`${formatCompact(p.rows_in)} → ${formatCompact(p.rows_out)} rows`}
            ms={p.elapsed_ms}
            share={pipelinesMs > 0 ? p.elapsed_ms / pipelinesMs : 0}
          />
        ))}
        <Box sx={{ mt: 1, borderTop: 1, borderColor: "divider" }}>
          <Item selected={view === "text"} onClick={() => setView("text")} title="Plan text" />
        </Box>
      </Box>
      <Box sx={{ minWidth: 0, minHeight: 0 }}>
        {view === "plan" && <PlanGraph plan={analysis.plan} totalMs={totalMs} onOpen={setNode} />}
        {typeof view === "number" && <PipelineGraph pipelines={pipelines} index={view} nodes={nodes} totalMs={totalMs} onOpen={setNode} onPick={setView} />}
        {view === "text" && (
          <Typography variant="mono" component="pre" sx={{ m: 0, p: 2, height: "100%", boxSizing: "border-box", overflow: "auto", whiteSpace: "pre", fontSize: 11.5 }}>
            {analysis.text}
          </Typography>
        )}
      </Box>
      {node && <NodeDetail node={node} totalMs={totalMs} onClose={() => setNode(null)} />}
    </Box>
  );
}
