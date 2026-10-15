/**
 * Foundry palette: warm paper and green-tinted graphite, one verdigris accent.
 *
 * Light is paper with ink; dark is graphite with the same hues lifted in lightness.
 * Verdigris is the primary accent, ochre the secondary (running and warnings).
 */

export const night = {
  background: "#171B1A",
  surface: "#1F2523",
  raised: "#262E2B",
  line: "#2C3431",
  text: "#DCE3E0",
  textDim: "#8B9892",
  textFaint: "#5C6863",
} as const;

export const paper = {
  background: "#F1EDE3",
  surface: "#FAF7F0",
  raised: "#E4DFD0",
  line: "#D3CCBA",
  text: "#25302D",
  textDim: "#5E6863",
  textFaint: "#8D948F",
} as const;

export const accents = {
  /** primary: verdigris */
  verdigris: "#4FB39C",
  verdigrisInk: "#2F6F62",
  /** secondary: ochre */
  ochre: "#E0B04A",
  ochreInk: "#A87A15",
  /** success */
  moss: "#5CC08F",
  mossInk: "#2E7D50",
  /** error */
  brick: "#E5604B",
  brickInk: "#C2452F",
  /** warning */
  amber: "#E0B04A",
  amberInk: "#B07F1C",
} as const;

export const fonts = {
  sans: '"Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
  mono: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "Cascadia Code", Consolas, monospace',
} as const;

/** Colors of operator kinds in query plans and profiles. */
export const operatorColors: Record<string, string> = {
  scan: accents.verdigris,
  join: accents.ochre,
  aggregate: accents.moss,
  sort: "#B69CFF",
  filter: "#7FD1E8",
  window: "#FF9E7A",
  recursive: "#E7A3F0",
  other: night.textDim,
};
