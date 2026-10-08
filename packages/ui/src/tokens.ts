/**
 * Observatory palette: a night sky with brass instruments.
 *
 * Dark is the native scheme (deep navy, starlight text); light is warm paper
 * with ink. Brass is the Workhouse brand accent in both.
 */

export const night = {
  background: "#0B1020",
  surface: "#121A2E",
  raised: "#1A2440",
  line: "#26314F",
  text: "#E6EAF2",
  textDim: "#9AA4BC",
  textFaint: "#5E6A86",
} as const;

export const paper = {
  background: "#F7F6F2",
  surface: "#FFFFFF",
  raised: "#EFEDE6",
  line: "#DEDBD2",
  text: "#1B2233",
  textDim: "#5A6275",
  textFaint: "#8C93A3",
} as const;

export const accents = {
  /** primary: nebula blue */
  nebula: "#6EA8FE",
  nebulaInk: "#2F6FD6",
  /** brand: brass */
  brass: "#D4A24C",
  brassInk: "#A87A22",
  /** success */
  aurora: "#5FD3A6",
  auroraInk: "#1F9E73",
  /** error */
  mars: "#F2777A",
  marsInk: "#C93B40",
  /** warning */
  nova: "#F5C46B",
  novaInk: "#B7801A",
} as const;

export const fonts = {
  sans: '"Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "Cascadia Code", Consolas, monospace',
} as const;

/** Colors of operator kinds in query plans and profiles. */
export const operatorColors: Record<string, string> = {
  scan: accents.nebula,
  join: accents.brass,
  aggregate: accents.aurora,
  sort: "#B69CFF",
  filter: "#7FD1E8",
  window: "#FF9E7A",
  recursive: "#E7A3F0",
  other: "#9AA4BC",
};
