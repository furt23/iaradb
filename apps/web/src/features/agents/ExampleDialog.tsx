"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useState } from "react";

import { CodeEditor } from "@/features/editor/CodeEditor";
import { useTranslation } from "@/i18n";
import type { AgentExample } from "@/lib/agents/types";

/** Adds or edits one question and the SQL that answers it. It is mounted while open. */
export function ExampleDialog({ initial, onClose, onSave }: { initial: AgentExample | null; onClose(): void; onSave(example: AgentExample): void }) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState(initial?.question ?? "");
  const [sql, setSql] = useState(initial?.sql ?? "");

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>{initial ? t("Edit SQL example") : t("Add SQL example")}</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 1 }}>
        <TextField
          autoFocus
          fullWidth
          label={t("Question")}
          placeholder={t("Which channel had the highest average ticket last quarter?")}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <Box>
          <Typography variant="caption" sx={{ display: "block", mb: 0.5, color: "text.secondary" }}>
            {t("Expected SQL")}
          </Typography>
          <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, overflow: "hidden" }}>
            <CodeEditor value={sql} language="sql" onChange={setSql} minHeight={144} maxHeight={320} lineNumbers={false} />
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("Cancel")}</Button>
        <Button variant="contained" disabled={question.trim() === ""} onClick={() => onSave({ question: question.trim(), sql })}>
          {t("Save example")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
