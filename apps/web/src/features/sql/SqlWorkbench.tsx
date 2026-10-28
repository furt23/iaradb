"use client";

import SaveOutlined from "@mui/icons-material/SaveOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import { IaraMark } from "@iara/ui";
import { useMemo, useState } from "react";

import { CodeEditor } from "@/features/editor/CodeEditor";
import { IaraPanel } from "@/features/iara/IaraPanel";
import { ReviewBar } from "@/features/iara/ReviewBar";
import { NewQueryDialog } from "@/features/queries/NewQueryDialog";
import { ParamBar } from "@/features/queries/ParamBar";
import { joinQuery, type ParamSpecs } from "@/features/queries/queryHeader";
import { detectParams, mergeSpecs, type ParamRaw, resolveParams } from "@/features/queries/queryParams";
import { useSqlIara } from "@/features/queries/sqlIaraBridge";
import { useTranslation } from "@/i18n";
import { PageHeader } from "@/features/shell/PageHeader";
import { useShell } from "@/features/shell/ShellProvider";

import { SqlResult } from "./SqlResult";
import { SqlRunButtons } from "./SqlRunButtons";
import { useSqlRunner } from "./useSqlRunner";

// the editor has no file: its Iara conversations are kept under this id
const IARA_FILE_ID = "sql-editor";
const IARA_PATH = "(unsaved query)";

/** Scratch queries on the default cluster; one worth keeping is saved as a .sql file. */
export function SqlWorkbench({ initialQuery, schema }: { initialQuery: string; schema: Record<string, { name: string }[]> }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState(initialQuery);
  const [saving, setSaving] = useState(false);
  const runner = useSqlRunner();
  const [saved, setSaved] = useState<ParamSpecs>({});
  const [values, setValues] = useState<Record<string, ParamRaw>>({});
  const specs = useMemo(() => mergeSpecs(detectParams(query), saved), [query, saved]);
  const { query: paramValues, missing } = resolveParams(specs, values);
  const run = () => (!runner.running && query.trim() && missing.length === 0 ? runner.run(query, paramValues) : undefined);
  const { iaraOpen, setIaraOpen } = useShell();
  const edit = (sql: string) => {
    setQuery(sql);
    return sql;
  };
  const iara = useSqlIara({ path: IARA_PATH, text: query, body: query, runner, blocked: missing.length > 0, edit, run });
  const review = iara.review;
  const keep = () => review?.decide.keep(missing.length === 0);
  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <PageHeader
        title={t("SQL editor")}
        actions={
          <>
            <Button startIcon={<SaveOutlined />} onClick={() => setSaving(true)} sx={{ color: "text.secondary" }}>
              {t("Save as…")}
            </Button>
            <Button startIcon={<IaraMark size={20} />} onClick={() => setIaraOpen(!iaraOpen)} sx={{ color: iaraOpen ? "secondary.main" : "text.secondary" }}>
              {t("Iara")}
            </Button>
            <SqlRunButtons runner={runner} onRun={run} query={query} values={paramValues} blocked={missing.length > 0} />
          </>
        }
      />
      <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>
        <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 }}>
          <ParamBar specs={specs} values={values} onValues={setValues} onSpecs={(next) => setSaved({ ...saved, ...next })} onRun={run} />
          <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2, flex: 1, minHeight: 0, overflow: "auto" }}>
            <Paper variant="outlined" sx={{ overflow: "hidden", flexShrink: 0 }}>
              {review && <ReviewBar decide={review.decide} canRun={missing.length === 0} />}
              <CodeEditor
                value={review ? review.code : query}
                original={review?.original}
                onChange={review ? review.setCode : setQuery}
                language="sql"
                schema={schema}
                onRun={review ? keep : run}
                onRunInPlace={review ? keep : run}
                onSave={() => setSaving(true)}
                minHeight={160}
                maxHeight={360}
                autoFocus
              />
            </Paper>
            <Paper variant="outlined" sx={{ overflow: "hidden", flexShrink: 0 }}>
              <SqlResult runner={runner} />
            </Paper>
          </Box>
        </Box>
        {iaraOpen && <IaraPanel fileId={IARA_FILE_ID} surface="sql" getContext={iara.getContext} adapter={iara.adapter} onClose={() => setIaraOpen(false)} />}
      </Box>
      <NewQueryDialog open={saving} text={joinQuery({ chart: null, params: specs, body: query })} onClose={() => setSaving(false)} />
    </Box>
  );
}
