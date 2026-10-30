"use client";

import Box from "@mui/material/Box";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import { useTranslation } from "react-i18next";

import type { NumberFormat } from "@/lib/dashboards/types";

import { styleOf, withDecimals, withStyle, type FormatStyle } from "./measureFormat";

const STYLES: { value: FormatStyle; label: string }[] = [
  { value: "auto", label: "Automatic" },
  { value: "number", label: "Number" },
  { value: "currency", label: "Currency" },
  { value: "percent", label: "Percent" },
];

/** A measure's number format on one line: its style, then the decimals once there is a style. `onChange(null)`: automatic. */
export function MeasureFormatControl({ format, disabled, onChange }: { format: NumberFormat | undefined; disabled?: boolean; onChange(format: NumberFormat | null): void }) {
  const { t } = useTranslation();
  return (
    <Box sx={{ display: "flex", gap: 1, flexShrink: 0 }}>
      <TextField select size="small" label={t("Format")} value={styleOf(format)} disabled={disabled} onChange={(e) => onChange(withStyle(format, e.target.value as FormatStyle))} sx={{ width: 130 }}>
        {STYLES.map((s) => (
          <MenuItem key={s.value} value={s.value}>
            {t(s.label)}
          </MenuItem>
        ))}
      </TextField>
      {format && (
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
      )}
    </Box>
  );
}
