"use client";

import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { NumberFormat } from "@/lib/dashboards/types";

/** The format without its undefined keys, so none is saved. */
function without(format: NumberFormat): NumberFormat {
  return Object.fromEntries(Object.entries(format).filter(([, v]) => v !== undefined)) as NumberFormat;
}

/** How numbers are written: a style, then its decimal places, currency and compact notation. Automatic (undefined) writes them as they come. */
export function NumberFormatFields({
  label,
  value,
  onChange,
}: {
  label: string;
  value: NumberFormat | undefined;
  onChange(v: NumberFormat | undefined): void;
}) {
  const { t } = useTranslation();
  // the currency code being typed: the format keeps the last complete one until the field loses focus
  const [typed, setTyped] = useState<string | null>(null);

  /** The format with `change` applied (nothing while automatic). */
  const change = (patch: Partial<NumberFormat>) => value && onChange(without({ ...value, ...patch }));

  const pickStyle = (style: string) => {
    if (style === "auto") return onChange(undefined);
    const next = style as NumberFormat["style"];
    onChange(without({ style: next, currency: next === "currency" ? "BRL" : undefined, decimals: value?.decimals, compact: value?.compact }));
  };

  return (
    <Stack spacing={1.5}>
      <TextField select size="small" fullWidth label={label} value={value?.style ?? "auto"} onChange={(e) => pickStyle(e.target.value)}>
        <MenuItem value="auto">{t("Automatic")}</MenuItem>
        <MenuItem value="number">{t("Number")}</MenuItem>
        <MenuItem value="currency">{t("Currency")}</MenuItem>
        <MenuItem value="percent">{t("Percent")}</MenuItem>
      </TextField>
      {value && (
        <>
          <TextField
            size="small"
            fullWidth
            type="number"
            label={t("Decimal places")}
            placeholder={t("Automatic")}
            value={value.decimals ?? ""}
            slotProps={{ htmlInput: { min: 0, max: 10 } }}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              change({ decimals: e.target.value === "" || Number.isNaN(n) ? undefined : Math.min(10, Math.max(0, n)) });
            }}
          />
          {value.style === "currency" && (
            <TextField
              size="small"
              fullWidth
              label={t("Currency")}
              value={typed ?? value.currency ?? ""}
              onBlur={() => setTyped(null)}
              onChange={(e) => {
                const code = e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
                setTyped(code);
                if (code.length === 3) change({ currency: code });
              }}
            />
          )}
          <FormControlLabel
            control={<Switch size="small" checked={!!value.compact} onChange={(_, v) => change({ compact: v || undefined })} />}
            label={t("Compact (1.2K)")}
          />
        </>
      )}
    </Stack>
  );
}
