"use client";

import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";
import { createWorkhouseTheme } from "@workhouse/ui";
import type { ReactNode } from "react";

const theme = createWorkhouseTheme();

export function ThemeRegistry({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider theme={theme} defaultMode="dark">
      <CssBaseline enableColorScheme />
      {children}
    </ThemeProvider>
  );
}
