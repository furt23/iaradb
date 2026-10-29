"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { ColumnInfo } from "@iara/protocol";
import { useCallback, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { CodeEditor } from "@/features/editor/CodeEditor";
import type { Dataset, NumberFormat } from "@/lib/dashboards/types";
import { isNumericType } from "@/lib/format";
import { checkModel } from "@/lib/model/check";
import { MODEL_FUNCTIONS } from "@/lib/model/functions/registry";
import type { Checked } from "@/lib/model/types";

import { columnsIn, type FoundColumns } from "./useDatasetColumns";
import { modelSchema } from "./useModel";
import { useModelComplete } from "./useModelComplete";

const SECTION_HEADING = { fontSize: 12, fontWeight: 650, color: "text.secondary" };
const MONO = { fontFamily: "var(--font-mono, monospace)", fontSize: 12, overflowWrap: "anywhere" } as const;
const STYLE_LABEL: Record<NumberFormat["style"], string> = { number: "Number", currency: "Currency", percent: "Percent" };

function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <Stack spacing={1}>
      <Typography sx={SECTION_HEADING}>{heading}</Typography>
      {children}
    </Stack>
  );
}

/** The dashboard's semantic model: its source on the left (checked as it is typed), what it defines on the right. */
export function ModelTab({
  source,
  checked,
  datasets,
  found,
  load,
  onChange,
}: {
  source: string;
  /** the source as checked (its measures and relationships are listed) */
  checked: Checked;
  datasets: Dataset[];
  found: FoundColumns;
  load(name: string): Promise<ColumnInfo[]>;
  onChange(source: string): void;
}) {
  const { t } = useTranslation();
  const schema = useMemo(() => modelSchema(datasets, found), [datasets, found]);
  // the source is checked against the columns, so they are read when the tab opens
  useEffect(() => {
    for (const d of datasets) load(d.name).catch(() => undefined);
  }, [datasets, load]);
  const lint = useCallback(
    async (code: string) => checkModel(code, schema).diagnostics.map(({ from, to, severity, message }) => ({ from, to, severity, message })),
    [schema],
  );
  const complete = useModelComplete(checked.model, schema);
  // memoised: the editor rebuilds its extensions when it gets a new assist object
  const assist = useMemo(() => ({ lint, complete }), [lint, complete]);

  const first = datasets[0];
  const numeric = first ? columnsIn(found, first.name).find((c) => isNumericType(c.type)) : undefined;
  const example = first
    ? `${t("# one measure per line: name = expression; datasets are available by name")}\n${numeric ? `total = sum(${first.name}.${numeric.name})` : `rows = count_rows(${first.name})`}\n`
    : "";
  const { measures, relationships, calendars, params } = checked.model;
  const formatText = (f: NumberFormat) => [t(STYLE_LABEL[f.style]), f.currency].filter(Boolean).join(" ");
  const none = <Typography sx={{ fontSize: 12, color: "text.disabled" }}>{t("None yet")}</Typography>;

  return (
    <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>
      <Box sx={{ flex: 1, minWidth: 0, overflow: "auto", p: 2 }}>
        {!source.trim() && (
          <Alert
            severity="info"
            sx={{ mb: 2 }}
            action={
              <Button color="inherit" size="small" disabled={!first} onClick={() => onChange(example)}>
                {t("Insert example")}
              </Button>
            }
          >
            {t("No measures yet. Write one per line, as name = expression, or insert an example.")}
          </Alert>
        )}
        <Paper variant="outlined" sx={{ overflow: "hidden" }}>
          <CodeEditor value={source} onChange={onChange} language="python" assist={assist} minHeight={400} />
        </Paper>
      </Box>
      <Box component="aside" aria-label={t("Model")} sx={{ width: 300, flexShrink: 0, overflow: "auto", borderLeft: 1, borderColor: "divider", bgcolor: "background.paper" }}>
        <Stack spacing={3} sx={{ p: 2 }}>
          <Section heading={t("Measures")}>
            {measures.length
              ? measures.map((m) => (
                  <Box key={m.span.from}>
                    <Typography sx={MONO}>{m.name}</Typography>
                    <Typography sx={{ fontSize: 12, color: "text.secondary" }}>{[m.datasets.join(", "), m.format && formatText(m.format)].filter(Boolean).join(" · ")}</Typography>
                  </Box>
                ))
              : none}
          </Section>
          <Section heading={t("Relationships")}>
            {relationships.length
              ? relationships.map((r) => <Typography key={r.span.from} sx={MONO}>{`${r.many.dataset}.${r.many.column} → ${r.one.dataset}.${r.one.column}`}</Typography>)
              : none}
          </Section>
          <Section heading={t("Calendars")}>
            {calendars.length ? calendars.map((c) => <Typography key={c.span.from} sx={MONO}>{`${c.name} ← ${c.columns.map((x) => `${x.dataset}.${x.column}`).join(", ")}`}</Typography>) : none}
          </Section>
          <Section heading={t("Parameters")}>
            {params.length ? params.map((p) => <Typography key={p.span.from} sx={MONO}>{`${p.name} = ${JSON.stringify(p.default)}`}</Typography>) : none}
          </Section>
          <Section heading={t("Functions")}>
            {MODEL_FUNCTIONS.map((f) => (
              <Box key={f.name}>
                <Typography sx={MONO}>{f.signature}</Typography>
                <Typography sx={{ fontSize: 12, color: "text.secondary" }}>{t(f.doc)}</Typography>
              </Box>
            ))}
          </Section>
        </Stack>
      </Box>
    </Box>
  );
}
