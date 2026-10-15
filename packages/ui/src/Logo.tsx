import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

import { logoScales } from "./tokens";

/** Iara's scales stacked 1-2-3: each half disc is a scale, each row a layer of data. */
const SCALES: { d: string; shade: 0 | 1 | 2 }[] = [
  { d: "M11.2 7.6A4.8 4.8 0 0 0 20.8 7.6Z", shade: 0 },
  { d: "M6.2 13.6A4.8 4.8 0 0 0 15.8 13.6Z", shade: 0 },
  { d: "M16.2 13.6A4.8 4.8 0 0 0 25.8 13.6Z", shade: 1 },
  { d: "M1.2 19.6A4.8 4.8 0 0 0 10.8 19.6Z", shade: 1 },
  { d: "M11.2 19.6A4.8 4.8 0 0 0 20.8 19.6Z", shade: 2 },
  { d: "M21.2 19.6A4.8 4.8 0 0 0 30.8 19.6Z", shade: 1 },
];

/** The Iara mark. Its blues lighten in the dark scheme so the darkest scale stays visible. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <Box
      component="svg"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Iara"
      sx={(theme) => ({
        "--scale-0": logoScales.light[0],
        "--scale-1": logoScales.light[1],
        "--scale-2": logoScales.light[2],
        ...theme.applyStyles("dark", {
          "--scale-0": logoScales.dark[0],
          "--scale-1": logoScales.dark[1],
          "--scale-2": logoScales.dark[2],
        }),
      })}
    >
      {SCALES.map(({ d, shade }) => (
        <path key={d} d={d} fill={`var(--scale-${shade})`} />
      ))}
    </Box>
  );
}

export function Logo({ product = "Studio" }: { product?: string }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
      <LogoMark />
      <Typography sx={{ fontWeight: 700, letterSpacing: "-0.01em", fontSize: 15 }}>
        Iara
        <Box component="span" sx={{ color: "secondary.main", fontWeight: 600, ml: 0.75 }}>
          {product}
        </Box>
      </Typography>
    </Box>
  );
}
