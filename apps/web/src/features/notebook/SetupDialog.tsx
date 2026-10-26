"use client";

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Typography from "@mui/material/Typography";
import type { Cell } from "@iara/protocol";
import { useEffect, useMemo, useState } from "react";

import { CodeEditor } from "@/features/editor/CodeEditor";

import { cellAssist } from "./cellAssist";

export interface SetupDialogProps {
  open: boolean;
  /** notebook path (code assistance runs in its kernel) */
  path: string;
  cell: Cell | undefined;
  /** the last run's error, first line */
  error: string | null;
  running: boolean;
  /** the notebook's cluster runs: without it, Shift+Enter saves and there is no run button */
  canRun: boolean;
  onClose(): void;
  /** applies the code to the cell, as an edit of any other cell */
  onSave(id: string, code: string): void;
  /** `onSave` first, then runs the cell (and the ones that read its names) */
  onRun(id: string, code: string): void;
}

/** The notebook's setup code (`with app.setup:`): imports and names every cell can use. It is not shown among the cells. */
export function SetupDialog({ open, path, cell, error, running, canRun, onClose, onSave, onRun }: SetupDialogProps) {
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (open && cell) setDraft(cell.code);
    // the draft starts from the cell's code each time the dialog opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const assist = useMemo(() => (cell ? cellAssist(path, cell.id, "python") : undefined), [path, cell]);
  if (!cell) return null;
  const save = () => (onSave(cell.id, draft), onClose());
  const run = () => (onRun(cell.id, draft), onClose());
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>Setup code</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ color: "text.secondary", mb: 1.5 }}>
          Runs before every other cell.
        </Typography>
        {error && (
          <Typography variant="body2" role="alert" sx={{ color: "error.main", mb: 1.5 }}>
            Last run failed: {error}
          </Typography>
        )}
        <CodeEditor
          value={draft}
          onChange={setDraft}
          language="python"
          assist={assist}
          autoFocus
          minHeight={160}
          maxHeight={420}
          onRun={canRun ? run : save}
          onRunInPlace={canRun ? run : save}
          onSave={save}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={save}>Save</Button>
        {canRun && (
          <Button variant="contained" color="secondary" onClick={run} disabled={running}>
            Save and run
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
