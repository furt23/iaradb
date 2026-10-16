/**
 * Foundry palette: warm paper and green-tinted graphite, accented with the blues of the logo.
 *
 * Light is paper with ink; dark is graphite with the same hues lifted in lightness.
 * Cobalt is the primary accent and azure the secondary (selection, run actions, tabs).
 * Ochre is kept for running state and warnings.
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
  /** primary: cobalt, the logo blues */
  cobalt: "#4A8FE0",
  cobaltInk: "#1E5BB8",
  /** secondary: azure, the lighter logo blue */
  azure: "#7FB2F0",
  azureInk: "#2E72CC",
  /** running state */
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

/** The scales of the logo, darkest to lightest, for each scheme. */
export const logoScales = {
  light: ["#1E5BB8", "#4A8FE0", "#A9CBF2"],
  dark: ["#4A8FE0", "#7FB2F0", "#C9DEF8"],
} as const;

export const fonts = {
  sans: '"Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: '"Roboto Slab Variable", "Roboto Slab", Georgia, serif',
  mono: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "Cascadia Code", Consolas, monospace',
} as const;

/** Colors of operator kinds in query plans and profiles. */
export const operatorColors: Record<string, string> = {
  scan: accents.cobalt,
  join: accents.ochre,
  aggregate: accents.moss,
  sort: "#B69CFF",
  filter: "#7FD1E8",
  window: "#FF9E7A",
  recursive: "#E7A3F0",
  other: night.textDim,
};
