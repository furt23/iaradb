"use client";

import SaveOutlined from "@mui/icons-material/SaveOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import { useMemo, useState } from "react";

import { CodeEditor } from "@/features/editor/CodeEditor";
import { NewQueryDialog } from "@/features/queries/NewQueryDialog";
import { ParamBar } from "@/features/queries/ParamBar";
import { joinQuery, type ParamSpecs } from "@/features/queries/queryHeader";
import { detectParams, mergeSpecs, type ParamRaw, resolveParams } from "@/features/queries/queryParams";
import { useTranslation } from "@/i18n";
import { PageHeader } from "@/features/shell/PageHeader";

import { SqlResult } from "./SqlResult";
import { SqlRunButtons } from "./SqlRunButtons";
import { useSqlRunner } from "./useSqlRunner";

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
  const run = () => !runner.running && query.trim() && missing.length === 0 && runner.run(query, paramValues);
  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <PageHeader
        title={t("SQL editor")}
        actions={
          <>
            <Button startIcon={<SaveOutlined />} onClick={() => setSaving(true)} sx={{ color: "text.secondary" }}>
              {t("Save as…")}
            </Button>
            <SqlRunButtons runner={runner} onRun={run} query={query} values={paramValues} blocked={missing.length > 0} />
          </>
        }
      />
      <ParamBar specs={specs} values={values} onValues={setValues} onSpecs={(next) => setSaved({ ...saved, ...next })} onRun={run} />
      <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2, flex: 1, minHeight: 0, overflow: "auto" }}>
        <Paper variant="outlined" sx={{ overflow: "hidden", flexShrink: 0 }}>
          <CodeEditor value={query} onChange={setQuery} language="sql" schema={schema} onRun={run} onRunInPlace={run} onSave={() => setSaving(true)} minHeight={160} maxHeight={360} autoFocus />
        </Paper>
        <Paper variant="outlined" sx={{ overflow: "hidden", flexShrink: 0 }}>
          <SqlResult runner={runner} />
        </Paper>
      </Box>
      <NewQueryDialog open={saving} text={joinQuery({ chart: null, params: specs, body: query })} onClose={() => setSaving(false)} />
    </Box>
  );
}
