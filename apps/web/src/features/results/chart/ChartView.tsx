"use client";

import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import type { ChartData, ChartSpec, ResultMeta } from "@iara/protocol";
import { useEffect, useMemo, useState } from "react";

import { fetchResultChart } from "@/server/actions/kernels";

import { ChartCanvas } from "./ChartCanvas";
import { ChartControls } from "./ChartControls";
import { defaultSpec, fitSpec, specProblem } from "./chartSpec";

const FETCH_DELAY_MS = 250;

/**
 * A chart over a result. The kernel aggregates (or samples) the result, so
 * only the drawn points cross the wire; `spec` is saved by the owner of the
 * output (the cell or the query file). The last chart stays drawn while the
 * next one loads.
 */
export function ChartView({ kernelKey, meta, spec: saved, onSpec, height = 320 }: { kernelKey: string; meta: ResultMeta; spec: ChartSpec | null; onSpec(spec: ChartSpec): void; height?: number }) {
  const spec = useMemo(() => (saved ? fitSpec(saved, meta.columns) : defaultSpec(meta.columns)), [saved, meta.columns]);
  const problem = spec ? specProblem(spec, meta.columns) : "This result has no columns.";
  const [shown, setShown] = useState<{ data: ChartData; spec: ChartSpec } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = JSON.stringify(spec);

  // keyed by the spec's text: a re-render with an equal spec fetches nothing
  useEffect(() => {
    const wanted = JSON.parse(request) as ChartSpec | null;
    if (!wanted || problem) return;
    let current = true;
    setBusy(true);
    // controls change one value at a time: wait for the last one
    const timer = setTimeout(() => {
      void fetchResultChart(kernelKey, meta.id, wanted).then((r) => {
        if (!current) return;
        setBusy(false);
        if (r.ok) {
          setShown({ data: r.data, spec: wanted });
          setError(null);
        } else setError(r.error.message);
      });
    }, FETCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [kernelKey, meta.id, request, problem]);

  if (!spec) return <Typography sx={{ p: 2, color: "text.secondary" }}>This result has no columns.</Typography>;
  const xType = (s: ChartSpec) => meta.columns.find((c) => c.name === s.x)?.type ?? "";
  return (
    <Box>
      <ChartControls spec={spec} columns={meta.columns} onChange={onSpec} />
      <Box role="figure" aria-label="chart" sx={{ height, position: "relative", px: 1 }}>
        {problem ? (
          <Typography sx={{ p: 2, color: "text.secondary" }}>{problem}</Typography>
        ) : error ? (
          <Typography variant="mono" component="pre" sx={{ p: 2, m: 0, color: "error.main", whiteSpace: "pre-wrap" }}>
            {error}
          </Typography>
        ) : (
          shown && <ChartCanvas data={shown.data} spec={shown.spec} height={height} xType={xType(shown.spec)} />
        )}
        {busy && !problem && <CircularProgress size={20} sx={{ position: "absolute", top: 12, right: 16 }} />}
      </Box>
      {!problem && !error && shown?.data.truncated && (
        <Typography sx={{ px: 2, pb: 1, fontSize: 12, color: "text.disabled" }}>
          {shown.spec.kind === "bar" ? "Showing the largest categories only." : "Showing a sample of the rows."}
        </Typography>
      )}
    </Box>
  );
}
