"use client";

import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import type { CellValue } from "@iara/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ParamSpec } from "@/features/queries/queryHeader";
import type { FilterValue, FilterWidget } from "@/lib/dashboards/types";

import { optionText, pickedValue, shownText, textValue, withRangeEnd } from "./filterValue";

const TYPING_DELAY_MS = 400;

/** The choices, plus the picked ones they do not hold (the options are capped, a value may not be among them). */
function withPicked(choices: string[], picked: string[]): string[] {
  const extra = picked.filter((p) => !choices.includes(p));
  return extra.length ? [...extra, ...choices] : choices;
}

/** One choice out of a list; clearing it leaves the filter without a value. */
function PickOne({ label, choices, value, placeholder, onPick }: { label: string; choices: string[]; value: string | null; placeholder?: string; onPick(text: string | null): void }) {
  return (
    <Autocomplete
      size="small"
      options={withPicked(choices, value === null ? [] : [value])}
      value={value}
      onChange={(_, text) => onPick(text)}
      renderInput={(params) => <TextField {...params} label={label} placeholder={placeholder} />}
    />
  );
}

/** Several choices out of a list, as chips. */
function PickMany({ label, choices, value, onPick }: { label: string; choices: string[]; value: string[]; onPick(texts: string[]): void }) {
  return (
    <Autocomplete
      multiple
      size="small"
      disableCloseOnSelect
      limitTags={2}
      options={withPicked(choices, value)}
      value={value}
      onChange={(_, texts) => onPick(texts)}
      renderInput={(params) => <TextField {...params} label={label} />}
    />
  );
}

/** A text field that hands over what was typed once typing pauses. */
function TypedField({ label, type, value, placeholder, onCommit }: { label: string; type: "text" | "number"; value: string; placeholder?: string; onCommit(text: string): void }) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commit = useRef(onCommit);
  useEffect(() => {
    commit.current = onCommit;
  });
  // a value set from outside replaces the draft, unless the draft already means it ("1." for 1)
  useEffect(() => setDraft((d) => (textValue(type, d) === textValue(type, value) ? d : value)), [type, value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <TextField
      fullWidth
      type={type}
      label={label}
      placeholder={placeholder}
      value={draft}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => commit.current(text), TYPING_DELAY_MS);
      }}
    />
  );
}

/** One ISO date (`YYYY-MM-DD`). */
function DateField({ label, value, onChange }: { label: string; value: string; onChange(date: string): void }) {
  return <TextField fullWidth type="date" label={label} value={value} onChange={(e) => onChange(e.target.value)} />;
}

/** The input of a filter that fills a `:name` placeholder, by the placeholder's type. */
function ParamInput({ label, spec, value, onChange }: { label: string; spec: ParamSpec | undefined; value: FilterValue | undefined; onChange(value: FilterValue | undefined): void }) {
  const placeholder = spec?.default === undefined ? undefined : String(spec.default);
  switch (spec?.type) {
    case "boolean":
      return <FormControlLabel label={label} control={<Switch checked={typeof value === "boolean" ? value : spec.default === true} onChange={(_, on) => onChange(on)} />} />;
    case "select":
      return <PickOne label={label} choices={spec.options ?? []} value={shownText(value)} placeholder={placeholder} onPick={(text) => onChange(text ?? undefined)} />;
    case "date":
      return <DateField label={label} value={shownText(value) ?? ""} onChange={(date) => onChange(textValue("date", date))} />;
    default:
      return (
        <TypedField
          label={label}
          type={spec?.type === "number" ? "number" : "text"}
          value={shownText(value) ?? ""}
          placeholder={placeholder}
          onCommit={(text) => onChange(textValue(spec?.type, text))}
        />
      );
  }
}

/**
 * The control of a filter widget. A field filter narrows the columns it names
 * (`options` are the distinct values the kernel read for it); a param filter
 * fills a placeholder, drawn as `paramSpec` says. An empty control is no value
 * (`undefined`), so the dashboard shows everything.
 */
export function FilterControl({
  filter,
  options,
  paramSpec,
  value,
  onChange,
}: {
  filter: FilterWidget;
  options: CellValue[];
  paramSpec?: ParamSpec;
  value: FilterValue | undefined;
  onChange(value: FilterValue | undefined): void;
}) {
  const { t } = useTranslation();
  const choices = useMemo(() => options.map(optionText), [options]);
  const label = filter.title ?? filter.fields?.[0]?.column ?? filter.param ?? t("Filter");
  if (filter.param) return <ParamInput label={label} spec={paramSpec} value={value} onChange={onChange} />;

  switch (filter.control) {
    case "select":
      return <PickOne label={label} choices={choices} value={shownText(value)} onPick={(text) => onChange(text === null ? undefined : pickedValue(filter, text))} />;
    case "multi":
      return <PickMany label={label} choices={choices} value={Array.isArray(value) ? value : []} onPick={(texts) => onChange(texts.length ? texts : undefined)} />;
    case "date_range": {
      const range = value && typeof value === "object" && !Array.isArray(value) ? value : {};
      return (
        <Box role="group" aria-label={label} sx={{ display: "flex", gap: 1 }}>
          <DateField label={t("From")} value={range.from ?? ""} onChange={(date) => onChange(withRangeEnd(value, "from", date))} />
          <DateField label={t("To")} value={range.to ?? ""} onChange={(date) => onChange(withRangeEnd(value, "to", date))} />
        </Box>
      );
    }
    case "text":
      return <TypedField label={label} type="text" value={shownText(value) ?? ""} onCommit={(text) => onChange(textValue("text", text))} />;
  }
}
