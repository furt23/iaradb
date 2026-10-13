"use client";

import TuneRounded from "@mui/icons-material/TuneRounded";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Popover from "@mui/material/Popover";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { QueryParamType } from "@workhouse/protocol";
import { useState } from "react";

import { PARAM_TYPES, type ParamSpec, type ParamSpecs } from "./queryHeader";
import { coerce, type ParamRaw, resolveParams, shown } from "./queryParams";

const INPUT_TYPE: Record<QueryParamType, string> = { text: "text", number: "number", date: "date", select: "text", boolean: "text" };

/** The default `spec` keeps when its type changes to `type`: only what still makes sense. */
function respec(spec: ParamSpec, type: QueryParamType): ParamSpec {
  const next: ParamSpec = { type };
  if (type === "select") next.options = spec.options ?? [];
  const kept = spec.default === undefined ? undefined : coerce(next, spec.default);
  if (kept !== undefined) next.default = kept;
  return next;
}

/** One parameter's type, default and options. */
function Settings({ name, spec, value, onChange }: { name: string; spec: ParamSpec; value: ParamRaw; onChange(next: ParamSpec): void }) {
  const [options, setOptions] = useState((spec.options ?? []).join(", "));
  const setDefault = (raw: ParamRaw | undefined) => {
    const { default: _old, ...rest } = spec;
    const v = raw === undefined ? undefined : coerce(spec, raw);
    onChange(v === undefined ? rest : { ...rest, default: v });
  };
  const current = coerce(spec, value);
  return (
    <Box sx={{ p: 2, width: 280, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Typography sx={{ fontWeight: 650, fontSize: 13 }}>:{name}</Typography>
      <TextField select size="small" label="Type" value={spec.type} onChange={(e) => onChange(respec(spec, e.target.value as QueryParamType))}>
        {PARAM_TYPES.map((t) => (
          <MenuItem key={t} value={t}>
            {t}
          </MenuItem>
        ))}
      </TextField>
      {spec.type === "select" && (
        <TextField
          size="small"
          label="Options"
          helperText="Comma separated"
          value={options}
          onChange={(e) => setOptions(e.target.value)}
          onBlur={() =>
            onChange({
              ...spec,
              options: options
                .split(",")
                .map((o) => o.trim())
                .filter(Boolean),
            })
          }
        />
      )}
      {spec.type === "boolean" ? (
        <FormControlLabel
          control={<Switch size="small" checked={spec.default === true} onChange={(e) => setDefault(e.target.checked)} />}
          label={<Typography sx={{ fontSize: 13 }}>Default on</Typography>}
        />
      ) : (
        <TextField
          size="small"
          label="Default"
          type={INPUT_TYPE[spec.type]}
          value={spec.default === undefined ? "" : String(spec.default)}
          onChange={(e) => setDefault(e.target.value === "" ? undefined : e.target.value)}
          slotProps={{ inputLabel: { shrink: true } }}
        />
      )}
      <Button size="small" disabled={current === undefined || current === spec.default} onClick={() => setDefault(value)} sx={{ alignSelf: "flex-start" }}>
        Save current value as default
      </Button>
    </Box>
  );
}

function Field({ name, spec, value, error, onValue, onSpec, onRun }: { name: string; spec: ParamSpec; value: ParamRaw; error: boolean; onValue(v: ParamRaw): void; onSpec(s: ParamSpec): void; onRun?(): void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && onRun) {
      e.preventDefault();
      onRun();
    }
  };
  return (
    <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.25 }}>
      {spec.type === "boolean" ? (
        <FormControlLabel
          sx={{ ml: 0, height: 40 }}
          control={<Switch size="small" checked={value === true} onChange={(e) => onValue(e.target.checked)} />}
          label={<Typography sx={{ fontSize: 13 }}>{name}</Typography>}
        />
      ) : (
        <TextField
          select={spec.type === "select"}
          size="small"
          label={name}
          type={spec.type === "select" ? undefined : INPUT_TYPE[spec.type]}
          value={String(value)}
          error={error}
          helperText={error ? "required" : undefined}
          onChange={(e) => onValue(e.target.value)}
          onKeyDown={onEnter}
          slotProps={{ inputLabel: { shrink: true }, htmlInput: spec.type === "number" ? { step: "any" } : undefined }}
          sx={{ minWidth: spec.type === "date" ? 150 : 140, maxWidth: 240 }}
        >
          {spec.type === "select" &&
            (spec.options ?? []).map((o) => (
              <MenuItem key={o} value={o}>
                {o}
              </MenuItem>
            ))}
        </TextField>
      )}
      <IconButton size="small" aria-label={`${name} settings`} onClick={(e) => setAnchor(e.currentTarget)} sx={{ mt: 0.5, color: "text.disabled" }}>
        <TuneRounded sx={{ fontSize: 16 }} />
      </IconButton>
      <Popover open={!!anchor} anchorEl={anchor} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: "bottom", horizontal: "left" }}>
        <Settings name={name} spec={spec} value={value} onChange={onSpec} />
      </Popover>
    </Box>
  );
}

/**
 * One input per `:name` placeholder of a query. The values are the tab's own
 * (not saved in the file); the gear edits the parameter's spec, which is.
 */
export function ParamBar({ specs, values, onValues, onSpecs, onRun }: { specs: ParamSpecs; values: Record<string, ParamRaw>; onValues(next: Record<string, ParamRaw>): void; onSpecs(next: ParamSpecs): void; onRun?(): void }) {
  const names = Object.keys(specs);
  if (names.length === 0) return null;
  const { missing } = resolveParams(specs, values);
  return (
    <Box aria-label="query parameters" sx={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", columnGap: 2, rowGap: 1.5, px: 2, py: 1.5, borderBottom: 1, borderColor: "divider", bgcolor: "background.paper", flexShrink: 0 }}>
      {names.map((name) => (
        <Field
          key={name}
          name={name}
          spec={specs[name]}
          value={shown(specs[name], values[name])}
          error={missing.includes(name)}
          onValue={(v) => onValues({ ...values, [name]: v })}
          onSpec={(s) => onSpecs({ ...specs, [name]: s })}
          onRun={onRun}
        />
      ))}
    </Box>
  );
}
