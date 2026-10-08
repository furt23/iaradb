/** The Workhouse Studio MUI theme: Observatory palette, CSS variables, both schemes. */

import { createTheme, type Theme } from "@mui/material/styles";

import { accents, fonts, night, paper } from "./tokens";

declare module "@mui/material/styles" {
  interface Palette {
    brass: Palette["primary"];
  }
  interface PaletteOptions {
    brass?: PaletteOptions["primary"];
  }
  interface TypeBackground {
    raised: string;
  }
  interface TypographyVariants {
    mono: React.CSSProperties;
  }
  interface TypographyVariantsOptions {
    mono?: React.CSSProperties;
  }
}

declare module "@mui/material/Typography" {
  interface TypographyPropsVariantOverrides {
    mono: true;
  }
}

declare module "@mui/material/Button" {
  interface ButtonPropsColorOverrides {
    brass: true;
  }
}

declare module "@mui/material/Chip" {
  interface ChipPropsColorOverrides {
    brass: true;
  }
}

const dark = {
  palette: {
    mode: "dark" as const,
    primary: { main: accents.nebula, contrastText: night.background },
    secondary: { main: accents.brass, contrastText: night.background },
    brass: { main: accents.brass, contrastText: night.background },
    success: { main: accents.aurora },
    error: { main: accents.mars },
    warning: { main: accents.nova },
    info: { main: accents.nebula },
    background: { default: night.background, paper: night.surface, raised: night.raised },
    text: { primary: night.text, secondary: night.textDim, disabled: night.textFaint },
    divider: night.line,
  },
};

const light = {
  palette: {
    mode: "light" as const,
    primary: { main: accents.nebulaInk },
    secondary: { main: accents.brassInk },
    brass: { main: accents.brassInk, contrastText: "#FFFFFF" },
    success: { main: accents.auroraInk },
    error: { main: accents.marsInk },
    warning: { main: accents.novaInk },
    info: { main: accents.nebulaInk },
    background: { default: paper.background, paper: paper.surface, raised: paper.raised },
    text: { primary: paper.text, secondary: paper.textDim, disabled: paper.textFaint },
    divider: paper.line,
  },
};

export function createWorkhouseTheme(): Theme {
  return createTheme({
    cssVariables: { colorSchemeSelector: "data-scheme" },
    colorSchemes: { dark, light },
    defaultColorScheme: "dark",
    shape: { borderRadius: 8 },
    typography: {
      fontFamily: fonts.sans,
      fontSize: 13,
      h1: { fontSize: "1.6rem", fontWeight: 650, letterSpacing: "-0.02em" },
      h2: { fontSize: "1.3rem", fontWeight: 650, letterSpacing: "-0.01em" },
      h3: { fontSize: "1.1rem", fontWeight: 600 },
      h4: { fontSize: "1rem", fontWeight: 600 },
      button: { textTransform: "none", fontWeight: 600 },
      overline: { fontWeight: 650, letterSpacing: "0.12em" },
      mono: { fontFamily: fonts.mono, fontSize: "0.8rem" },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          "html, body": { height: "100%" },
          body: { overflow: "hidden" },
          "code, pre, kbd": { fontFamily: fonts.mono },
          "*::-webkit-scrollbar": { width: 10, height: 10 },
          "*::-webkit-scrollbar-thumb": { borderRadius: 8, backgroundColor: "rgba(127,138,165,0.35)" },
          "*::-webkit-scrollbar-track": { background: "transparent" },
        },
      },
      MuiPaper: { styleOverrides: { root: { backgroundImage: "none" } } },
      MuiButton: { defaultProps: { disableElevation: true, size: "small" } },
      MuiIconButton: { defaultProps: { size: "small" } },
      MuiTooltip: { defaultProps: { arrow: true, enterDelay: 400 } },
      MuiTextField: { defaultProps: { size: "small" } },
      MuiChip: { defaultProps: { size: "small" }, styleOverrides: { root: { fontWeight: 600 } } },
      MuiTab: { styleOverrides: { root: { minHeight: 40, textTransform: "none" } } },
      MuiTabs: { styleOverrides: { root: { minHeight: 40 } } },
    },
  });
}
