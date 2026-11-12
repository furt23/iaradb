"use client";

import CheckOutlined from "@mui/icons-material/CheckOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import Popover from "@mui/material/Popover";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useState } from "react";
import { useTranslation } from "react-i18next";

const HEX = /^#[0-9a-fA-F]{6}$/;
/** besides the palette's: for a number or a bar that should not take a palette's color */
const NEUTRALS = ["#ffffff", "#c4cbd4", "#7b8794", "#3e4c59", "#111827"];

/** Colors to click, a code to type or the system's picker, and the way back to the automatic color. */
function Swatches({ palette, value, onChange }: { palette: string[]; value: string | undefined; onChange(color: string | undefined): void }) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState<string | null>(null);
  const colors = [...new Set([...palette, ...NEUTRALS])];
  const same = (c: string) => c.toLowerCase() === value?.toLowerCase();
  return (
    <Stack spacing={1}>
      <Box role="radiogroup" aria-label={t("Colors")} sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, 26px)", gap: 0.75 }}>
        {colors.map((c) => (
          <ButtonBase
            key={c}
            role="radio"
            aria-checked={same(c)}
            aria-label={c}
            title={c}
            onClick={() => onChange(c)}
            sx={{ width: 26, height: 26, borderRadius: "4px", bgcolor: c, border: 1, borderColor: same(c) ? "text.primary" : "divider", outline: same(c) ? 2 : 0, outlineStyle: "solid", outlineColor: "primary.main", outlineOffset: 1 }}
          >
            {same(c) && <CheckOutlined sx={{ fontSize: 16, color: "#fff", mixBlendMode: "difference" }} />}
          </ButtonBase>
        ))}
      </Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Box component="input" type="color" aria-label={t("Pick any color")} value={value && HEX.test(value) ? value : palette[0]} onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)} sx={{ width: 34, height: 34, p: 0, border: 1, borderColor: "text.disabled", borderRadius: "4px", bgcolor: "transparent", cursor: "pointer", flexShrink: 0 }} />
        <TextField
          size="small"
          placeholder="#rrggbb"
          value={typed ?? value ?? ""}
          onBlur={() => setTyped(null)}
          onChange={(e) => {
            setTyped(e.target.value);
            if (HEX.test(e.target.value)) onChange(e.target.value);
          }}
          slotProps={{ htmlInput: { "aria-label": t("Color code"), maxLength: 7 } }}
          sx={{ flex: 1, minWidth: 0 }}
        />
        <Button size="small" disabled={!value} onClick={() => onChange(undefined)} sx={{ flexShrink: 0 }}>
          {t("Automatic")}
        </Button>
      </Box>
    </Stack>
  );
}

/**
 * The color of one thing on a chart. `inline`: it is the only one, so its colors show right here; otherwise a row with
 * its name and color, which opens them. `fallback`: what it is drawn in while it has no color of its own (none: the theme's).
 */
export function ColorField({ label, palette, value, fallback, inline, onChange }: { label: string; palette: string[]; value: string | undefined; fallback?: string; inline?: boolean; onChange(color: string | undefined): void }) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (inline) return <Swatches palette={palette} value={value} onChange={onChange} />;
  const shown = value ?? fallback;
  return (
    <>
      <ButtonBase onClick={(e) => setAnchor(e.currentTarget)} aria-label={`${t("Color of")} ${label}`} sx={{ width: "100%", minHeight: 36, display: "flex", justifyContent: "flex-start", gap: 1, px: 0.75, borderRadius: "4px", bgcolor: "action.selected", textAlign: "left" }}>
        <Box aria-hidden sx={{ width: 22, height: 22, flexShrink: 0, borderRadius: "4px", bgcolor: shown, border: 1, borderColor: "divider" }} />
        <Typography noWrap title={label} sx={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 550, color: "text.primary" }}>
          {label}
        </Typography>
        <Typography sx={{ fontSize: 11, color: "text.secondary", fontFamily: "var(--font-mono, monospace)", flexShrink: 0 }}>{value ?? t("Automatic")}</Typography>
      </ButtonBase>
      <Popover open={anchor !== null} anchorEl={anchor} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: "bottom", horizontal: "left" }}>
        <Box sx={{ p: 1.5, width: 280 }}>
          <Swatches palette={palette} value={value} onChange={onChange} />
        </Box>
      </Popover>
    </>
  );
}
