"use client";

import Add from "@mui/icons-material/Add";
import Close from "@mui/icons-material/Close";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";

import { NOTIFY_EVENTS, type NotifyEvent } from "@/lib/jobs";

import { blankNotify, notifyError, type NotifyDraft } from "./jobForm";

const LABELS: Record<NotifyEvent, string> = { start: "Start", success: "Success", failure: "Failure" };

/** Webhooks called when a run starts, succeeds or fails. */
export function NotifyFields({ rows, onChange }: { rows: NotifyDraft[]; onChange(rows: NotifyDraft[]): void }) {
  const set = (i: number, patch: Partial<NotifyDraft>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Stack spacing={1} role="group" aria-label="notifications">
      {rows.map((r, i) => {
        const error = notifyError(r);
        return (
          <Stack key={i} direction="row" spacing={1} sx={{ alignItems: "flex-start", flexWrap: "wrap", rowGap: 0.5 }}>
            <TextField
              size="small"
              label="Webhook URL"
              value={r.webhook}
              onChange={(e) => set(i, { webhook: e.target.value })}
              error={Boolean(error)}
              helperText={error ?? " "}
              sx={{ flex: 1, minWidth: 260 }}
              slotProps={{ htmlInput: { "aria-label": `webhook URL ${i + 1}` } }}
            />
            <Stack direction="row" sx={{ alignItems: "center", pt: 0.25 }}>
              {NOTIFY_EVENTS.map((ev) => (
                <FormControlLabel
                  key={ev}
                  label={LABELS[ev]}
                  sx={{ mr: 0.5, "& .MuiFormControlLabel-label": { fontSize: 13 } }}
                  control={
                    <Checkbox
                      size="small"
                      checked={r.on.includes(ev)}
                      onChange={(e) => set(i, { on: e.target.checked ? [...r.on, ev] : r.on.filter((x) => x !== ev) })}
                      slotProps={{ input: { "aria-label": `notify on ${ev} ${i + 1}` } }}
                    />
                  }
                />
              ))}
              <IconButton size="small" aria-label={`remove webhook ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                <Close fontSize="small" />
              </IconButton>
            </Stack>
          </Stack>
        );
      })}
      <Button size="small" startIcon={<Add />} onClick={() => onChange([...rows, blankNotify()])} sx={{ alignSelf: "flex-start" }}>
        Add webhook
      </Button>
    </Stack>
  );
}
