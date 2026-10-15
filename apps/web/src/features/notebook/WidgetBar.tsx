"use client";

import Box from "@mui/material/Box";
import Checkbox from "@mui/material/Checkbox";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import InputLabel from "@mui/material/InputLabel";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import type { WidgetDefinition, WidgetValue, WidgetsState } from "@iara/protocol";
import { useEffect, useRef, useState } from "react";

import { choiceKey, inputText, pickChoice, sameValue, valueToSend, WIDGET_DEBOUNCE_MS } from "./widgets";

export interface WidgetBarProps {
  widgets: WidgetsState;
  /** the user set a widget: the kernel runs the cells that read it */
  onChange(name: string, value: WidgetValue): void;
}

interface InputProps {
  def: WidgetDefinition;
  value: WidgetValue | undefined;
  onChange(name: string, value: WidgetValue): void;
}

const FIELD_WIDTH = 200;

/** Text and number: typing waits {@link WIDGET_DEBOUNCE_MS} before it is sent; Enter and leaving the field send at once. */
function TypedInput({ def, value, onChange }: InputProps) {
  const [draft, setDraft] = useState(inputText(value));
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(value);
  latest.current = value;

  // what the kernel says shows, unless the user is typing
  useEffect(() => {
    if (!focused.current) setDraft(inputText(value));
  }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const send = (text: string) => {
    clearTimeout(timer.current);
    const v = valueToSend(def, text);
    if (v !== null && !sameValue(v, latest.current)) onChange(def.name, v);
    return v;
  };
  return (
    <TextField
      size="small"
      label={def.label}
      type={def.kind === "number" ? "number" : "text"}
      value={draft}
      sx={{ width: FIELD_WIDTH }}
      slotProps={def.kind === "number" ? { htmlInput: { min: def.min ?? undefined, max: def.max ?? undefined, step: def.step ?? "any" } } : undefined}
      onFocus={() => (focused.current = true)}
      onChange={(e) => {
        setDraft(e.target.value);
        clearTimeout(timer.current);
        const text = e.target.value;
        timer.current = setTimeout(() => send(text), WIDGET_DEBOUNCE_MS);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") send(draft);
      }}
      onBlur={() => {
        focused.current = false;
        if (send(draft) === null) setDraft(inputText(latest.current));
      }}
    />
  );
}

function DropdownInput({ def, value, onChange }: InputProps) {
  const id = `widget-${def.name}`;
  return (
    <FormControl size="small" sx={{ width: FIELD_WIDTH }}>
      <InputLabel id={`${id}-label`}>{def.label}</InputLabel>
      <Select
        labelId={`${id}-label`}
        label={def.label}
        value={value === null || value === undefined ? "" : String(value)}
        onChange={(e) => onChange(def.name, pickChoice(def, e.target.value))}
      >
        {(def.choices ?? []).map((c) => (
          <MenuItem key={choiceKey(c)} value={choiceKey(c)}>
            {choiceKey(c)}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

function MultiselectInput({ def, value, onChange }: InputProps) {
  const id = `widget-${def.name}`;
  const picked = (Array.isArray(value) ? value : []).map(String);
  return (
    <FormControl size="small" sx={{ width: FIELD_WIDTH }}>
      <InputLabel id={`${id}-label`}>{def.label}</InputLabel>
      <Select
        multiple
        labelId={`${id}-label`}
        label={def.label}
        value={picked}
        renderValue={(v) => v.join(", ")}
        onChange={(e) => {
          const next = e.target.value;
          onChange(def.name, (typeof next === "string" ? next.split(",") : next).map(String));
        }}
      >
        {(def.choices ?? []).map((c) => (
          <MenuItem key={choiceKey(c)} value={choiceKey(c)} dense>
            <Checkbox size="small" checked={picked.includes(choiceKey(c))} sx={{ p: 0.5, mr: 1 }} />
            <ListItemText primary={choiceKey(c)} />
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

function WidgetInput(p: InputProps) {
  const { def, value, onChange } = p;
  switch (def.kind) {
    case "text":
    case "number":
      return <TypedInput {...p} />;
    case "dropdown":
      return <DropdownInput {...p} />;
    case "multiselect":
      return <MultiselectInput {...p} />;
    case "checkbox":
      return (
        <FormControlLabel
          label={def.label}
          control={<Checkbox size="small" checked={value === true} onChange={(e) => onChange(def.name, e.target.checked)} />}
          sx={{ mr: 0 }}
        />
      );
    case "date":
      return (
        <TextField
          size="small"
          type="date"
          label={def.label}
          value={inputText(value)}
          sx={{ width: FIELD_WIDTH }}
          slotProps={{ inputLabel: { shrink: true } }}
          onChange={(e) => onChange(def.name, e.target.value === "" ? null : e.target.value)}
        />
      );
  }
}

/** The notebook's widgets (`iara.widgets.*`), set from here; nothing is shown while the notebook has none. */
export function WidgetBar({ widgets, onChange }: WidgetBarProps) {
  if (widgets.definitions.length === 0) return null;
  return (
    <Box
      role="group"
      aria-label="Notebook widgets"
      sx={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 1.5, px: { xs: 1, md: 4 }, py: 1.25, flexShrink: 0, borderBottom: 1, borderColor: "divider" }}
    >
      {widgets.definitions.map((def) => (
        <WidgetInput key={def.name} def={def} value={widgets.values[def.name]} onChange={onChange} />
      ))}
    </Box>
  );
}
