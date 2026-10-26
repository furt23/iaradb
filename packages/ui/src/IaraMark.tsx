import Box from "@mui/material/Box";

import { logoScales } from "./tokens";

/**
 * The mark of Iara the chat agent: a water drop holding a half-disc scale and
 * a sparkle. It shares the logo's theme-aware blues; while the agent works the
 * sparkle pulses (not under reduced motion).
 */
export function IaraMark({ size = 20, thinking = false }: { size?: number; thinking?: boolean }) {
  return (
    <Box
      component="svg"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Iara"
      sx={(theme) => ({
        flexShrink: 0,
        "--scale-0": logoScales.light[0],
        "--scale-2": logoScales.light[2],
        ...theme.applyStyles("dark", {
          "--scale-0": logoScales.dark[0],
          "--scale-2": logoScales.dark[2],
        }),
        "& .sparkle": {
          // the sparkle's center, in the viewBox's units
          transformOrigin: "12.5px 13px",
          ...(thinking && {
            animation: "iara-sparkle 1.2s ease-in-out infinite",
            "@keyframes iara-sparkle": { "50%": { transform: "scale(0.55)", opacity: 0.4 } },
            "@media (prefers-reduced-motion: reduce)": { animation: "none" },
          }),
        },
      })}
    >
      <path d="M16 2C16 2 6 13.5 6 20A10 10 0 0 0 26 20C26 13.5 16 2 16 2Z" fill="var(--scale-0)" />
      <path d="M10.5 20A5.5 5.5 0 0 0 21.5 20Z" fill="var(--scale-2)" />
      <path className="sparkle" d="M12.5 10.5Q12.9 12.6 15 13Q12.9 13.4 12.5 15.5Q12.1 13.4 10 13Q12.1 12.6 12.5 10.5Z" fill="#fff" />
    </Box>
  );
}
