"use client";

import DeleteOutline from "@mui/icons-material/DeleteOutlineOutlined";
import ExpandMore from "@mui/icons-material/ExpandMore";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import { RUN_IFS, type RunIf } from "@/lib/jobs";

import type { TaskDraft, TaskFieldErrors } from "./jobForm";
import { ParamRows } from "./ParamRows";
import { TargetPicker } from "./TargetPicker";

const RUN_IF_LABELS: Record<RunIf, string> = {
  all_success: "All upstream tasks succeeded",
  all_done: "All upstream tasks finished",
  at_least_one_success: "At least one succeeded",
  none_failed: "None failed (skipped is fine)",
  all_failed: "All upstream tasks failed",
};

/** One task of a job: what it runs; after which tasks, retries and params under "Advanced". */
export function TaskEditor({
  draft,
  others,
  targets,
  single,
  errors,
  onChange,
  onRemove,
  autoFocus,
}: {
  draft: TaskDraft;
  /** the other tasks (what this one can wait for) */
  others: TaskDraft[];
  targets: string[];
  /** the job has just this task: no key at the top, no remove */
  single: boolean;
  errors: TaskFieldErrors;
  onChange(patch: Partial<TaskDraft>): void;
  onRemove(): void;
  autoFocus?: boolean;
}) {
  const size = single ? "medium" : "small";
  const keyField = (
    <TextField
      size={size}
      label="Task key"
      value={draft.key}
      onChange={(e) => onChange({ key: e.target.value })}
      error={!draft.key.trim()}
      sx={{ width: single ? 220 : 170 }}
      slotProps={{ htmlInput: { "aria-label": single ? "task key" : `task key ${draft.key}` } }}
    />
  );
  const targetField = (
    <TargetPicker
      value={draft.target}
      targets={targets}
      onChange={(target) => onChange({ target })}
      size={size}
      error={Boolean(errors.target)}
      helperText={errors.target ?? (single ? "A notebook or a query file" : undefined)}
      autoFocus={autoFocus}
    />
  );
  const upstream = others.filter((o) => o.key.trim());

  const advanced = (
    <Accordion disableGutters elevation={0} square sx={{ border: 0, "&:before": { display: "none" }, bgcolor: "transparent" }}>
      <AccordionSummary expandIcon={<ExpandMore />} sx={{ px: 0, minHeight: 36, "& .MuiAccordionSummary-content": { my: 0.5 } }}>
        <Typography sx={{ fontSize: 13, color: "text.secondary" }}>Advanced</Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 0, pt: 0.5 }}>
        <Stack spacing={2}>
          {single && keyField}
          {!single && (
            <TextField
              select
              size="small"
              label="Depends on"
              value={draft.dependsOn}
              onChange={(e) => onChange({ dependsOn: typeof e.target.value === "string" ? e.target.value.split(",") : e.target.value })}
              slotProps={{
                select: {
                  multiple: true,
                  displayEmpty: true,
                  renderValue: (v) =>
                    (v as string[])
                      .map((id) => others.find((o) => o.id === id)?.key)
                      .filter(Boolean)
                      .join(", ") || "none",
                },
                inputLabel: { shrink: true },
              }}
            >
              {upstream.map((o) => (
                <MenuItem key={o.id} value={o.id}>
                  {o.key}
                </MenuItem>
              ))}
            </TextField>
          )}
          {!single && draft.dependsOn.length > 0 && (
            <TextField select size="small" label="Run if" value={draft.runIf} onChange={(e) => onChange({ runIf: e.target.value as RunIf })}>
              {RUN_IFS.map((r) => (
                <MenuItem key={r} value={r}>
                  {RUN_IF_LABELS[r]}
                </MenuItem>
              ))}
            </TextField>
          )}
          <Stack direction="row" spacing={1.5} sx={{ flexWrap: "wrap", rowGap: 2 }}>
            <TextField
              size="small"
              label="Max retries"
              type="number"
              value={draft.maxRetries}
              onChange={(e) => onChange({ maxRetries: e.target.value })}
              error={Boolean(errors.maxRetries)}
              helperText={errors.maxRetries}
              sx={{ width: 130 }}
            />
            <TextField
              size="small"
              label="Retry wait (s)"
              type="number"
              value={draft.retryBackoffSeconds}
              onChange={(e) => onChange({ retryBackoffSeconds: e.target.value })}
              error={Boolean(errors.retryBackoffSeconds)}
              helperText={errors.retryBackoffSeconds}
              sx={{ width: 140 }}
            />
            <TextField
              size="small"
              label="Timeout (minutes)"
              type="number"
              value={draft.timeoutMinutes}
              placeholder="the job's"
              onChange={(e) => onChange({ timeoutMinutes: e.target.value })}
              error={Boolean(errors.timeoutMinutes)}
              helperText={errors.timeoutMinutes}
              sx={{ width: 170 }}
              slotProps={{ inputLabel: { shrink: true } }}
            />
          </Stack>
          <Box>
            <Typography sx={{ fontSize: 12.5, fontWeight: 600, mb: 0.75 }}>Task params</Typography>
            <ParamRows label="Task params" rows={draft.params} onChange={(params) => onChange({ params })} errors={errors.params} />
          </Box>
        </Stack>
      </AccordionDetails>
    </Accordion>
  );

  if (single) {
    return (
      <Stack spacing={0.5}>
        {targetField}
        {advanced}
      </Stack>
    );
  }
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }} aria-label={`task ${draft.key}`} role="group">
      <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
        {keyField}
        {targetField}
        <Tooltip title="Remove the task">
          <IconButton size="small" aria-label={`remove task ${draft.key}`} onClick={onRemove} sx={{ mt: 0.5 }}>
            <DeleteOutline fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      {advanced}
    </Paper>
  );
}
