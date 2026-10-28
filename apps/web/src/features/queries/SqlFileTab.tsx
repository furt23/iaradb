"use client";

import DescriptionOutlined from "@mui/icons-material/DescriptionOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import type { ChartSpec } from "@iara/protocol";
import { IaraMark } from "@iara/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CodeEditor } from "@/features/editor/CodeEditor";
import { IaraPanel } from "@/features/iara/IaraPanel";
import { ReviewBar } from "@/features/iara/ReviewBar";
import { ErrorState } from "@/features/shell/PageHeader";
import { useShell } from "@/features/shell/ShellProvider";
import { SqlResult } from "@/features/sql/SqlResult";
import { SqlRunButtons } from "@/features/sql/SqlRunButtons";
import { useSqlRunner } from "@/features/sql/useSqlRunner";
import { FileActionsMenu } from "@/features/workbench/FileActionsMenu";
import { fileIdOf } from "@/features/workbench/fileIdRegistry";
import { baseName, parentOf } from "@/lib/paths";
import { openQuery, saveQuery } from "@/server/actions/queries";

import { drafts, isEdited, release, retain } from "./drafts";
import { ParamBar } from "./ParamBar";
import { joinQuery, type ParamSpecs, splitQuery } from "./queryHeader";
import { detectParams, mergeSpecs, type ParamRaw, resolveParams } from "./queryParams";
import { useSqlIara } from "./sqlIaraBridge";

const AUTOSAVE_MS = 800;

type Status = "saved" | "unsaved" | "saving" | "failed";

/** Persist the draft of `path` (unless it moved or was closed meanwhile). */
async function persist(path: string): Promise<Status> {
  const draft = drafts.get(path);
  if (!draft || draft.text === draft.saved) return "saved";
  const text = draft.text;
  const r = await saveQuery(path, text);
  const now = drafts.get(path);
  if (r.ok && now) now.saved = text;
  if (!r.ok) return r.error.type === "NotFound" ? "saved" : "failed";
  return now && now.text !== text ? "unsaved" : "saved";
}

/**
 * A saved query in a workbench tab: edit (saved as you type), run on the
 * default cluster with Ctrl+Enter, explain. Its text lives in `drafts`, so a
 * rename (which remounts the tab) keeps unsaved edits.
 */
export function SqlFileTab({ path, shown, schema }: { path: string; shown: boolean; schema: Record<string, { name: string }[]> }) {
  const [text, setText] = useState<string | null>(() => drafts.get(path)?.text ?? null);
  const [failure, setFailure] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(() => {
    const d = drafts.get(path);
    return d && d.text !== d.saved ? "unsaved" : "saved";
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runner = useSqlRunner();
  // what each parameter is set to in this tab: not part of the file
  const [values, setValues] = useState<Record<string, ParamRaw>>({});
  const { iaraOpen, setIaraOpen } = useShell();

  // the file's text, the first time the tab is shown
  useEffect(() => {
    if (!shown || text !== null || failure) return;
    void openQuery(path).then((r) => {
      if (!r.ok) return setFailure(r.error.message);
      if (!drafts.has(path)) drafts.set(path, { text: r.data.text, saved: r.data.text });
      setText(drafts.get(path)!.text);
    });
  }, [shown, text, failure, path]);

  const save = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setStatus("saving");
    setStatus(await persist(path));
  }, [path]);

  useEffect(() => {
    retain(path);
    // edits that arrived with a rename are saved under the new name
    const draft = drafts.get(path);
    if (draft && draft.text !== draft.saved) timer.current = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (!release(path)) return;
      // the tab closed (a rename moved the draft away already): save what is
      // left, once no editor of the file came back (React remounts in development)
      setTimeout(() => {
        if (isEdited(path) || !drafts.has(path)) return;
        void persist(path).then(() => {
          if (!isEdited(path)) drafts.delete(path);
        });
      }, 0);
    };
  }, [path, save]);

  // the editor shows the query; the file also holds its chart, in a first-line comment
  const parts = splitQuery(text ?? "");
  const { chart, body } = parts;
  const specs = useMemo(() => mergeSpecs(detectParams(body), parts.params), [body, parts.params]);
  const { query: paramValues, missing } = resolveParams(specs, values);

  const change = (full: string) => {
    const draft = drafts.get(path);
    if (!draft) return;
    draft.text = full;
    setText(full);
    setStatus(full === draft.saved ? "saved" : "unsaved");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), AUTOSAVE_MS);
  };
  // the file's text after the edit: Iara waits for it to show
  const edit = (value: string) => {
    const full = joinQuery({ ...parts, body: value });
    change(full);
    return full;
  };
  const saveChart = (spec: ChartSpec) => change(joinQuery({ ...parts, chart: spec }));
  // the header keeps the specs of the placeholders the query has
  const saveSpecs = (next: ParamSpecs) => change(joinQuery({ ...parts, params: next }));

  const run = () => {
    if (!body.trim() || runner.running || missing.length > 0) return;
    void save();
    return runner.run(body, paramValues);
  };
  const iara = useSqlIara({ path, text, body, runner, blocked: missing.length > 0, edit, run });
  const review = iara.review;
  const keep = () => review?.decide.keep(missing.length === 0);

  if (failure) return <ErrorState title={`Could not open ${path}`} message={failure} />;
  if (text === null) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", pt: 8 }}>
        <CircularProgress size={22} />
      </Box>
    );
  }
  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, minHeight: 48, borderBottom: 1, borderColor: "divider", bgcolor: "background.paper", flexShrink: 0 }}>
        <DescriptionOutlined sx={{ fontSize: 18, color: "primary.main" }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography noWrap sx={{ fontWeight: 650, fontSize: 14 }}>
            {baseName(path)}
          </Typography>
          <Typography noWrap sx={{ fontSize: 11.5, color: "text.disabled" }}>
            {parentOf(path) || "/"}
          </Typography>
        </Box>
        <Typography aria-label="save status" sx={{ fontSize: 12, color: status === "failed" ? "error.main" : "text.disabled", mr: 1 }}>
          {status === "failed" ? "not saved" : status}
        </Typography>
        {status === "failed" && (
          <Button size="small" onClick={() => void save()}>
            Retry
          </Button>
        )}
        <FileActionsMenu path={path} kind="sql" />
        <Button startIcon={<IaraMark size={20} />} onClick={() => setIaraOpen(!iaraOpen)} sx={{ color: iaraOpen ? "secondary.main" : "text.secondary" }}>
          Iara
        </Button>
        <SqlRunButtons runner={runner} onRun={run} query={body} source={path} values={paramValues} blocked={missing.length > 0} />
      </Box>
      <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>
        <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 }}>
          <ParamBar specs={specs} values={values} onValues={setValues} onSpecs={saveSpecs} onRun={run} />
          <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2, flex: 1, minHeight: 0, overflow: "auto" }}>
            <Paper variant="outlined" sx={{ overflow: "hidden", flexShrink: 0 }}>
              {review && <ReviewBar decide={review.decide} canRun={missing.length === 0} />}
              <CodeEditor
                value={review ? review.code : body}
                original={review?.original}
                onChange={review ? review.setCode : edit}
                language="sql"
                schema={schema}
                onRun={review ? keep : run}
                onRunInPlace={review ? keep : run}
                onSave={() => void save()}
                minHeight={160}
                maxHeight={420}
              />
            </Paper>
            <Paper variant="outlined" sx={{ overflow: "hidden", flexShrink: 0 }}>
              <SqlResult runner={runner} chart={chart} onChart={saveChart} />
            </Paper>
          </Box>
        </Box>
        {iaraOpen && <IaraPanel fileId={fileIdOf(path) ?? path} surface="sql" getContext={iara.getContext} adapter={iara.adapter} onClose={() => setIaraOpen(false)} />}
      </Box>
    </Box>
  );
}
