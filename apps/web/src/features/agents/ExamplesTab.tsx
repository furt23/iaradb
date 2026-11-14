"use client";

import Search from "@mui/icons-material/Search";
import Add from "@mui/icons-material/Add";
import CodeOutlined from "@mui/icons-material/CodeOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useState } from "react";

import { useTranslation } from "@/i18n";
import { MAX_EXAMPLES } from "@/lib/agents/check";
import type { AgentExample } from "@/lib/agents/types";

import { SectionHeader, SectionLayout } from "./AgentSection";
import { ExampleDialog } from "./ExampleDialog";
import { ExampleRow } from "./ExampleRow";

/** The dialog is open for a new example (no index) or for the example at an index. */
type Dialog = { index?: number };

/** Questions the agent should answer, each with the SQL that answers it, and a test of that SQL. */
export function ExamplesTab({ slug, examples, onChange }: { slug: string; examples: AgentExample[]; onChange(e: AgentExample[]): void }) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [filter, setFilter] = useState("");
  const editing = dialog?.index === undefined ? null : examples[dialog.index];

  const save = (example: AgentExample) => {
    const index = dialog?.index;
    if (index === undefined) onChange([...examples, example]);
    else onChange(examples.map((e, i) => (i === index ? example : e)));
    setDialog(null);
  };
  const remove = (index: number) => onChange(examples.filter((_, i) => i !== index));

  // rows keep their index in the list, so edits and deletes reach the right example while filtering
  const query = filter.trim().toLowerCase();
  const shown = examples.map((example, index) => ({ example, index })).filter((x) => query === "" || x.example.question.toLowerCase().includes(query));

  const header = (
    <SectionHeader
      icon={<CodeOutlined />}
      title={t("SQL examples")}
      subtitle={t("Questions the agent reuses for questions like them")}
      stats={[
        { label: t("Examples"), value: String(examples.length) },
        { label: t("With SQL"), value: String(examples.filter((e) => e.sql.trim() !== "").length) },
      ]}
      actions={
        <Button variant="contained" startIcon={<Add />} disabled={examples.length >= MAX_EXAMPLES} onClick={() => setDialog({})}>
          {t("Add example")}
        </Button>
      }
    />
  );

  return (
    <SectionLayout header={header}>
      <Box sx={{ px: 3, py: 1.5, borderBottom: 1, borderColor: "divider" }}>
        <TextField
          fullWidth
          size="small"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("Filter examples")}
          slotProps={{
            htmlInput: { "aria-label": t("Filter examples") },
            input: { startAdornment: <Search fontSize="small" sx={{ color: "text.disabled", mr: 1 }} /> },
          }}
        />
      </Box>
      {examples.length === 0 && (
        <Typography sx={{ color: "text.secondary", py: 4, textAlign: "center" }}>{t("No SQL examples yet.")}</Typography>
      )}
      {examples.length > 0 && shown.length === 0 && (
        <Typography sx={{ color: "text.secondary", py: 4, textAlign: "center" }}>{t("No examples match the filter.")}</Typography>
      )}
      {shown.map(({ example, index }) => (
        <ExampleRow key={index} slug={slug} example={example} onEdit={() => setDialog({ index })} onDelete={() => remove(index)} />
      ))}
      {dialog && <ExampleDialog initial={editing} onClose={() => setDialog(null)} onSave={save} />}
    </SectionLayout>
  );
}
