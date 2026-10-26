import "@fontsource-variable/inter";
import "@fontsource-variable/roboto-slab";
import "@fontsource-variable/jetbrains-mono";

import InitColorSchemeScript from "@mui/material/InitColorSchemeScript";
import { AppRouterCacheProvider } from "@mui/material-nextjs/v16-appRouter";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { NotifyProvider } from "@/features/shell/notify";
import { ThemeRegistry } from "@/features/shell/ThemeRegistry";

import { I18nProvider } from "@/i18n/I18nProvider";

export const metadata: Metadata = {
  title: "Iara Studio",
  description: "Notebooks, SQL e um catálogo de dados no motor Iara",
};

export const dynamic = "force-dynamic";

/** What every page needs: theme, i18n, toasts. The Studio shell lives in `(studio)/layout.tsx`. */
export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="pt" suppressHydrationWarning>
      <body>
        <InitColorSchemeScript attribute="data-scheme" defaultMode="dark" />
        <AppRouterCacheProvider>
          <ThemeRegistry>
            <I18nProvider>
              <NotifyProvider>{children}</NotifyProvider>
            </I18nProvider>
          </ThemeRegistry>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}
