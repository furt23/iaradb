import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

import { accents } from "./tokens";

/** The Workhouse mark: a ochre orbit around a verdigris star, inside an observatory ring. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="Workhouse">
      <circle cx="16" cy="16" r="14" fill="none" stroke={accents.ochre} strokeWidth="2.2" />
      <ellipse cx="16" cy="16" rx="13" ry="5.2" fill="none" stroke={accents.ochre} strokeWidth="1.3" opacity="0.55" transform="rotate(-28 16 16)" />
      <circle cx="16" cy="16" r="4.2" fill={accents.verdigris} />
      <circle cx="26.2" cy="10.6" r="1.8" fill={accents.ochre} />
    </svg>
  );
}

export function Logo({ product = "Studio" }: { product?: string }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
      <LogoMark />
      <Typography sx={{ fontWeight: 700, letterSpacing: "-0.01em", fontSize: 15 }}>
        Workhouse
        <Box component="span" sx={{ color: "secondary.main", fontWeight: 600, ml: 0.75 }}>
          {product}
        </Box>
      </Typography>
    </Box>
  );
}
