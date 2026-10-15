/** The Iara Studio MUI theme: Foundry palette, CSS variables, both schemes. */

import { createTheme, type Theme } from "@mui/material/styles";
import { createSvgIcon } from "@mui/material/utils";

import { accents, fonts, night, paper } from "./tokens";

declare module "@mui/material/styles" {
  interface Palette {
    ochre: Palette["primary"];
  }
  interface PaletteOptions {
    ochre?: PaletteOptions["primary"];
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
    ochre: true;
  }
}

declare module "@mui/material/Chip" {
  interface ChipPropsColorOverrides {
    ochre: true;
  }
}

declare module "@mui/material/LinearProgress" {
  interface LinearProgressPropsColorOverrides {
    ochre: true;
  }
}

/** A thin chevron for selects (the MUI triangle reads as stock Material). */
const Chevron = createSvgIcon(<path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />, "Chevron");

/** The theme as style overrides get it: with its CSS variables. */
type VarsTheme = { vars: NonNullable<Theme["vars"]> };

/** A focus ring in the primary color. */
const ring = (theme: VarsTheme) => `0 0 0 3px rgba(${theme.vars.palette.primary.mainChannel} / 0.22)`;

/** Floating surfaces (menus, popovers, autocomplete lists): hairline border, soft shadow. */
const floating = (theme: VarsTheme) => ({
  backgroundColor: theme.vars.palette.background.paper,
  border: `1px solid ${theme.vars.palette.divider}`,
  borderRadius: 10,
  boxShadow: "0 8px 24px rgba(0,0,0,0.14), 0 2px 6px rgba(0,0,0,0.08)",
});

const dark = {
  palette: {
    mode: "dark" as const,
    primary: { main: accents.cobalt, contrastText: night.background },
    secondary: { main: accents.azure, contrastText: night.background },
    ochre: { main: accents.ochre, contrastText: night.background },
    success: { main: accents.moss },
    error: { main: accents.brick },
    warning: { main: accents.amber },
    info: { main: accents.cobalt },
    background: { default: night.background, paper: night.surface, raised: night.raised },
    text: { primary: night.text, secondary: night.textDim, disabled: night.textFaint },
    divider: night.line,
  },
};

const light = {
  palette: {
    mode: "light" as const,
    primary: { main: accents.cobaltInk },
    secondary: { main: accents.azureInk },
    ochre: { main: accents.ochreInk, contrastText: "#FFFFFF" },
    success: { main: accents.mossInk },
    error: { main: accents.brickInk },
    warning: { main: accents.amberInk },
    info: { main: accents.cobaltInk },
    background: { default: paper.background, paper: paper.surface, raised: paper.raised },
    text: { primary: paper.text, secondary: paper.textDim, disabled: paper.textFaint },
    divider: paper.line,
  },
};

export function createIaraTheme(): Theme {
  return createTheme({
    cssVariables: { colorSchemeSelector: "data-scheme" },
    colorSchemes: { dark, light },
    defaultColorScheme: "dark",
    shape: { borderRadius: 8 },
    typography: {
      fontFamily: fonts.sans,
      fontSize: 13,
      h1: { fontFamily: fonts.serif, fontSize: "1.7rem", fontWeight: 500, letterSpacing: "-0.01em" },
      h2: { fontFamily: fonts.serif, fontSize: "1.35rem", fontWeight: 500, letterSpacing: "-0.005em" },
      h3: { fontFamily: fonts.serif, fontSize: "1.15rem", fontWeight: 500 },
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
          "*::-webkit-scrollbar-thumb": { borderRadius: 8, backgroundColor: "rgba(127,138,130,0.35)" },
          "*::-webkit-scrollbar-track": { background: "transparent" },
        },
      },
      MuiPaper: { styleOverrides: { root: { backgroundImage: "none" } } },
      MuiButton: {
        defaultProps: { disableElevation: true, size: "small" },
        styleOverrides: { root: { borderRadius: 8 } },
        variants: [
          {
            // text buttons (Cancel, secondary actions) are quiet ink, not accent-colored
            props: { variant: "text", color: "primary" },
            style: ({ theme }) => ({
              color: theme.vars.palette.text.secondary,
              "&:hover": { color: theme.vars.palette.text.primary, backgroundColor: theme.vars.palette.action.hover },
            }),
          },
          {
            // neutral outlined buttons: ink text on a hairline, the accent stays for primary actions
            props: { variant: "outlined", color: "primary" },
            style: ({ theme }) => ({
              borderColor: theme.vars.palette.divider,
              color: theme.vars.palette.text.primary,
              "&:hover": { borderColor: theme.vars.palette.text.secondary, backgroundColor: theme.vars.palette.action.hover },
            }),
          },
        ],
      },
      MuiTableHead: {
        styleOverrides: {
          root: ({ theme }) => ({
            "& .MuiTableCell-root": {
              fontWeight: 500,
              fontSize: "0.75rem",
              color: theme.vars.palette.text.primary,
              borderTop: `1px solid ${theme.vars.palette.text.primary}`,
              borderBottom: `1px solid ${theme.vars.palette.text.primary}`,
              backgroundColor: "transparent",
            },
          }),
        },
      },
      MuiTableCell: {
        styleOverrides: {
          root: ({ theme }) => ({ borderBottom: `1px solid ${theme.vars.palette.divider}`, padding: "7px 10px" }),
        },
      },
      MuiIconButton: { defaultProps: { size: "small" }, styleOverrides: { root: { borderRadius: 8 } } },
      MuiTooltip: {
        defaultProps: { arrow: true, enterDelay: 400 },
        styleOverrides: {
          tooltip: ({ theme }) => ({
            backgroundColor: theme.vars.palette.text.primary,
            color: theme.vars.palette.background.default,
            fontSize: 12,
            fontWeight: 400,
            borderRadius: 6,
            padding: "5px 9px",
          }),
          arrow: ({ theme }) => ({ color: theme.vars.palette.text.primary }),
        },
      },
      MuiTextField: { defaultProps: { size: "small" } },
      MuiOutlinedInput: {
        styleOverrides: {
          root: ({ theme }) => ({
            borderRadius: 8,
            backgroundColor: theme.vars.palette.background.paper,
            transition: "box-shadow 120ms ease, border-color 120ms ease",
            "& .MuiOutlinedInput-notchedOutline": { borderColor: theme.vars.palette.divider },
            "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: theme.vars.palette.text.secondary },
            "&.Mui-focused": { boxShadow: ring(theme) },
            "&.Mui-focused .MuiOutlinedInput-notchedOutline": { borderColor: theme.vars.palette.primary.main, borderWidth: 1 },
            "&.Mui-error.Mui-focused": { boxShadow: `0 0 0 3px rgba(${theme.vars.palette.error.mainChannel} / 0.22)` },
            "& .MuiInputBase-inputSizeSmall": { paddingTop: 7, paddingBottom: 7 },
          }),
          // the label sits above the field (see MuiInputLabel): no notch cut into the border
          notchedOutline: { top: 0, "& legend": { display: "none" } },
        },
      },
      MuiFormControl: { defaultProps: { size: "small" } },
      MuiInputLabel: {
        // labels always sit above their field, never floating inside it
        defaultProps: { shrink: true },
        styleOverrides: {
          root: { fontSize: 13 },
          outlined: ({ theme }) => ({
            position: "relative",
            transform: "none",
            maxWidth: "100%",
            marginBottom: 6,
            fontSize: 12,
            fontWeight: 500,
            lineHeight: 1.4,
            color: theme.vars.palette.text.secondary,
            "&.Mui-focused": { color: theme.vars.palette.text.primary },
            "&.Mui-error": { color: theme.vars.palette.error.main },
            "&.Mui-disabled": { color: theme.vars.palette.text.disabled },
          }),
        },
      },
      MuiFormHelperText: { styleOverrides: { root: { margin: "5px 0 0", fontSize: 12, lineHeight: 1.45 } } },
      MuiSelect: {
        defaultProps: { IconComponent: Chevron, MenuProps: { elevation: 0 } },
        styleOverrides: {
          icon: ({ theme }) => ({ fontSize: 18, right: 8, color: theme.vars.palette.text.secondary }),
        },
      },
      MuiNativeSelect: { defaultProps: { IconComponent: Chevron } },
      MuiMenu: { defaultProps: { elevation: 0 }, styleOverrides: { paper: ({ theme }) => floating(theme), list: { padding: 4 } } },
      MuiPopover: { defaultProps: { elevation: 0 }, styleOverrides: { paper: ({ theme }) => floating(theme) } },
      MuiAutocomplete: {
        defaultProps: { popupIcon: <Chevron sx={{ fontSize: 18 }} /> },
        styleOverrides: {
          paper: ({ theme }) => ({ ...floating(theme), marginTop: 4 }),
          listbox: { padding: 4 },
          option: { borderRadius: 6, fontSize: 13, minHeight: 30 },
        },
      },
      MuiMenuItem: {
        styleOverrides: {
          root: ({ theme }) => ({
            borderRadius: 6,
            fontSize: 13,
            minHeight: 30,
            paddingTop: 4,
            paddingBottom: 4,
            "&.Mui-selected": { backgroundColor: `rgba(${theme.vars.palette.primary.mainChannel} / 0.12)` },
            "&.Mui-selected:hover": { backgroundColor: `rgba(${theme.vars.palette.primary.mainChannel} / 0.18)` },
          }),
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: ({ theme }) => ({
            borderRadius: 12,
            border: `1px solid ${theme.vars.palette.divider}`,
            boxShadow: "0 24px 64px rgba(0,0,0,0.25)",
          }),
        },
      },
      MuiDialogTitle: { styleOverrides: { root: { fontFamily: fonts.serif, fontSize: "1.3rem", fontWeight: 500, padding: "22px 24px 6px" } } },
      MuiDialogContent: {
        styleOverrides: {
          root: { padding: "10px 24px 8px", ".MuiDialogTitle-root + &": { paddingTop: 10 } },
        },
      },
      MuiDialogContentText: { styleOverrides: { root: { fontSize: 13.5 } } },
      MuiDialogActions: { styleOverrides: { root: { padding: "16px 24px 20px", gap: 8, "& > :not(style) ~ :not(style)": { marginLeft: 0 } } } },
      MuiBackdrop: { styleOverrides: { root: { backgroundColor: "rgba(10,14,13,0.45)" }, invisible: { backgroundColor: "transparent" } } },
      MuiCard: { defaultProps: { variant: "outlined" }, styleOverrides: { root: { borderRadius: 10 } } },
      MuiAlert: { styleOverrides: { root: { borderRadius: 8, fontSize: 13 } } },
      MuiSwitch: {
        defaultProps: { size: "small" },
        styleOverrides: { thumb: { boxShadow: "none" }, track: { borderRadius: 999, opacity: 0.35 } },
      },
      MuiCheckbox: { defaultProps: { size: "small" } },
      MuiRadio: { defaultProps: { size: "small" } },
      MuiToggleButton: { styleOverrides: { root: { textTransform: "none", borderRadius: 8, fontSize: 12.5 } } },
      MuiLinearProgress: { styleOverrides: { root: { height: 2 } } },
      MuiTabs: { styleOverrides: { root: { minHeight: 40 }, indicator: { height: 2, borderRadius: 2 } } },
      MuiChip: { defaultProps: { size: "small" }, styleOverrides: { root: { fontWeight: 500, borderRadius: 999 } } },
      MuiTab: { styleOverrides: { root: { minHeight: 40, textTransform: "none", fontWeight: 500 } } },
    },
  });
}
