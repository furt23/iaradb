"use client";

import Box from "@mui/material/Box";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import Tooltip from "@mui/material/Tooltip";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { NumberFormat } from "@/lib/dashboards/types";

import { styleOf, withCompact, withCurrency, withDecimals, withStyle, type FormatStyle } from "./measureFormat";

const STYLES: { value: FormatStyle; label: string }[] = [
  { value: "auto", label: "Automatic" },
  { value: "number", label: "Number" },
  { value: "currency", label: "Currency" },
  { value: "percent", label: "Percent" },
];

/** A measure's number format beside its expression: its style, then what the style has (decimals, currency, compact). `onChange(null)`: automatic. */
export function MeasureFormatControl({ format, disabled, onChange }: { format: NumberFormat | undefined; disabled?: boolean; onChange(format: NumberFormat | null): void }) {
  const { t } = useTranslation();
  // the currency code being typed: the format keeps the last complete one until the field loses focus
  const [typed, setTyped] = useState<string | null>(null);
  return (
    <Box role="group" aria-label={t("Number format")} sx={{ display: "flex", alignItems: "center", gap: 1, flexShrink: 0 }}>
      <TextField select size="small" label={t("Format")} value={styleOf(format)} disabled={disabled} onChange={(e) => onChange(withStyle(format, e.target.value as FormatStyle))} sx={{ width: 130 }}>
        {STYLES.map((s) => (
          <MenuItem key={s.value} value={s.value}>
            {t(s.label)}
          </MenuItem>
        ))}
      </TextField>
      {format?.style === "currency" && (
        <TextField
          size="small"
          label={t("Currency")}
          value={typed ?? format.currency ?? ""}
          disabled={disabled}
          onBlur={() => setTyped(null)}
          onChange={(e) => {
            const code = e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
            setTyped(code);
            if (code.length === 3) onChange(withCurrency(format, code));
          }}
          sx={{ width: 84 }}
        />
      )}
      {format && (
        <>
          <TextField
            size="small"
            type="number"
            label={t("Decimals")}
            placeholder={t("Automatic")}
            value={format.decimals ?? ""}
            disabled={disabled}
            onChange={(e) => onChange(withDecimals(format, e.target.value))}
            slotProps={{ htmlInput: { min: 0, max: 10, step: 1 }, inputLabel: { shrink: true } }}
            sx={{ width: 96 }}
          />
          <Tooltip title={t("Compact (1.2K)")}>
            <ToggleButton size="small" value="compact" selected={!!format.compact} disabled={disabled} aria-label={t("Compact (1.2K)")} onChange={() => onChange(withCompact(format, !format.compact))} sx={{ height: 40, px: 1.25, textTransform: "none", fontSize: 13 }}>
              1,2K
            </ToggleButton>
          </Tooltip>
        </>
      )}
    </Box>
  );
}
