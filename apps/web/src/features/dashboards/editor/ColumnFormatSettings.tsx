"use client";

import Add from "@mui/icons-material/Add";
import CloseOutlined from "@mui/icons-material/CloseOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { ColumnInfo } from "@iara/protocol";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { TONE_COLORS } from "@/lib/dashboards/conditional";
import type { ColorRule, ColumnFormat, TableWidget, Tone } from "@/lib/dashboards/types";
import { isNumericType } from "@/lib/format";

import { NumberFormatFields } from "./NumberFormatFields";

type Scale = NonNullable<ColumnFormat["scale"]>;

const OPS: ColorRule["op"][] = [">", ">=", "<", "<=", "=", "!="];
const TEXT_OPS: ColorRule["op"][] = ["=", "!="];
const TONES: { value: Tone; label: string }[] = [
  { value: "green", label: "Green" },
  { value: "amber", label: "Amber" },
  { value: "orange", label: "Orange" },
  { value: "red", label: "Red" },
  { value: "blue", label: "Blue" },
];
/** The color scales by name: one tone fading in from none, or `low` fading into `high`. */
const SCALES: [string, Scale | undefined][] = [
  ["None", undefined],
  ["Green", { high: "green" }],
  ["Blue", { high: "blue" }],
  ["Red", { high: "red" }],
  ["Amber", { high: "amber" }],
  ["Orange", { high: "orange" }],
  ["Red → Green", { low: "red", high: "green" }],
  ["Green → Red", { low: "green", high: "red" }],
];

/** The format without its empty parts (undefined when nothing is left). */
function tidy(format: ColumnFormat): ColumnFormat | undefined {
  const out: ColumnFormat = {};
  if (format.number) out.number = format.number;
  if (format.rules?.length) out.rules = format.rules;
  if (format.scale) out.scale = format.scale;
  return Object.keys(out).length ? out : undefined;
}

/** A rule's value: a number on a numeric column when it parses, else the text. */
function ruleValue(numeric: boolean, text: string): number | string {
  const n = Number(text);
  return numeric && text.trim() !== "" && !Number.isNaN(n) ? n : text;
}

function sameScale(a: Scale | undefined, b: Scale | undefined): boolean {
  return a?.high === b?.high && a?.low === b?.low;
}

/** How a table's columns are shown: the number format, rules and color scale of each. Edits go to `onChange` as the widget. */
export function ColumnFormatSettings({ widget, columns, onChange }: { widget: TableWidget; columns: ColumnInfo[]; onChange(widget: TableWidget): void }) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState("");
  // the widget's own columns when it picks some, else all of the dataset's
  const names = widget.columns ?? columns.map((c) => c.name);
  const name = names.includes(picked) ? picked : (names[0] ?? "");
  const numeric = isNumericType(columns.find((c) => c.name === name)?.type ?? "");
  const format: ColumnFormat = widget.formats?.[name] ?? {};
  const rules = format.rules ?? [];

  /** Saves the format of the column; a column with an empty format has none, and `formats` is undefined when no column has one. */
  const save = (next: ColumnFormat) => {
    const formats: Record<string, ColumnFormat> = {};
    for (const [key, f] of Object.entries({ ...widget.formats, [name]: next })) {
      const kept = tidy(f);
      if (kept) formats[key] = kept;
    }
    onChange({ ...widget, formats: Object.keys(formats).length ? formats : undefined });
  };
  const setRules = (next: ColorRule[]) => save({ ...format, rules: next });
  const setRule = (i: number, patch: Partial<ColorRule>) => setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Stack spacing={2}>
      <TextField select size="small" fullWidth label={t("Column")} value={name} onChange={(e) => setPicked(e.target.value)}>
        {names.map((n) => (
          <MenuItem key={n} value={n}>
            {n}
          </MenuItem>
        ))}
      </TextField>
      {name && (
        <>
          {numeric && <NumberFormatFields label={t("Number format")} value={format.number} onChange={(number) => save({ ...format, number })} />}
          <Stack spacing={1}>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              {t("Rules")}
            </Typography>
            {rules.map((rule, i) => (
              <Paper key={i} variant="outlined" sx={{ p: 1.5, display: "flex", gap: 1 }}>
                <Stack spacing={1.5} sx={{ flex: 1, minWidth: 0 }}>
                  <Stack direction="row" spacing={1}>
                    <TextField
                      select
                      size="small"
                      label={t("Operator")}
                      value={rule.op}
                      onChange={(e) => setRule(i, { op: e.target.value as ColorRule["op"] })}
                      sx={{ width: 100, flexShrink: 0 }}
                    >
                      {(numeric ? OPS : TEXT_OPS).map((op) => (
                        <MenuItem key={op} value={op}>
                          {op}
                        </MenuItem>
                      ))}
                    </TextField>
                    <TextField
                      size="small"
                      fullWidth
                      type={numeric ? "number" : "text"}
                      label={t("Value")}
                      value={rule.value}
                      onChange={(e) => setRule(i, { value: ruleValue(numeric, e.target.value) })}
                    />
                  </Stack>
                  <TextField select size="small" fullWidth label={t("Color")} value={rule.tone} onChange={(e) => setRule(i, { tone: e.target.value as Tone })}>
                    {TONES.map((tone) => (
                      <MenuItem key={tone.value} value={tone.value}>
                        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                          <Box sx={{ width: 12, height: 12, borderRadius: 0.5, flexShrink: 0, bgcolor: TONE_COLORS[tone.value] }} />
                          {t(tone.label)}
                        </Stack>
                      </MenuItem>
                    ))}
                  </TextField>
                </Stack>
                <IconButton size="small" aria-label={t("Remove rule")} onClick={() => setRules(rules.filter((_, j) => j !== i))} sx={{ alignSelf: "flex-start" }}>
                  <CloseOutlined fontSize="small" />
                </IconButton>
              </Paper>
            ))}
            <Button
              size="small"
              startIcon={<Add />}
              onClick={() => setRules([...rules, numeric ? { op: ">", value: 0, tone: "green" } : { op: "=", value: "", tone: "green" }])}
              sx={{ alignSelf: "flex-start" }}
            >
              {t("Add rule")}
            </Button>
          </Stack>
          {numeric && (
            <TextField
              select
              size="small"
              fullWidth
              label={t("Color scale")}
              value={SCALES.find(([, s]) => sameScale(s, format.scale))?.[0] ?? "None"}
              onChange={(e) => save({ ...format, scale: SCALES.find(([label]) => label === e.target.value)?.[1] })}
            >
              {SCALES.map(([label]) => (
                <MenuItem key={label} value={label}>
                  {t(label)}
                </MenuItem>
              ))}
            </TextField>
          )}
        </>
      )}
    </Stack>
  );
}
