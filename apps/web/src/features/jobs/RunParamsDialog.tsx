"use client";

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import { useEffect, useMemo, useState } from "react";

import type { JobSpec, Params } from "@/lib/jobs";

import { paramOverrides, paramsToRows, rowsToParams, type ParamRow } from "./jobForm";
import { ParamRows } from "./ParamRows";

/** Start a run with params: the job's, to change or add to for this run only. */
export function RunParamsDialog({ job, onClose, onRun }: { job: Pick<JobSpec, "name" | "params"> | null; onClose(): void; onRun(overrides: Params): void }) {
  const [rows, setRows] = useState<ParamRow[]>([]);
  useEffect(() => {
    if (job) setRows(paramsToRows(job.params));
  }, [job]);
  const parsed = useMemo(() => rowsToParams(rows), [rows]);
  return (
    <Dialog open={job !== null} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Run {job?.name} with parameters</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2, fontSize: 13.5 }}>For this run only. The job itself is not changed.</DialogContentText>
        <ParamRows label="Run params" rows={rows} onChange={setRows} errors={parsed.errors} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" color="secondary" disabled={parsed.errors.length > 0} onClick={() => onRun(paramOverrides(job?.params ?? {}, parsed.params))}>
          Run
        </Button>
      </DialogActions>
    </Dialog>
  );
}
