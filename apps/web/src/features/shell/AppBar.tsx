"use client";

import Search from "@mui/icons-material/Search";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import { LogoMark } from "@iara/ui";
import Link from "next/link";

import { useTranslation } from "@/i18n";
import { AccountMenu, type AppAccount } from "./AccountMenu";
import { LanguageMenu } from "./LanguageMenu";
import { useShell } from "./ShellProvider";
import { ThemeMenu } from "./ThemeMenu";

export const APP_BAR_HEIGHT = 48;

/**
 * The Studio's top bar: the mark and the workspace, search (Ctrl/Cmd+K),
 * the theme, and the account.
 */
export function AppBar({ workspace, account }: { workspace: string; account: AppAccount }) {
  const { setQuickOpen } = useShell();
  const { t } = useTranslation();
  return (
    <Box
      component="header"
      sx={{
        height: APP_BAR_HEIGHT,
        flexShrink: 0,
        display: "grid",
        gridTemplateColumns: "1fr minmax(0, 440px) 1fr",
        alignItems: "center",
        gap: 2,
        px: 1.5,
        borderBottom: 1,
        borderColor: "divider",
        bgcolor: "background.paper",
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>
        <Box
          component={Link}
          href="/notebooks"
          aria-label={t("Iara Studio home")}
          sx={{ display: "flex", alignItems: "center", gap: 1, color: "text.primary", textDecoration: "none", flexShrink: 0 }}
        >
          <LogoMark size={24} />
          <Typography variant="h3" component="span" sx={{ fontSize: 17, lineHeight: 1, display: { xs: "none", sm: "block" } }}>
            Iara
          </Typography>
        </Box>
        <Typography sx={{ color: "text.disabled", fontSize: 15, display: { xs: "none", md: "block" } }}>/</Typography>
        <Typography noWrap title={t("Workspace")} sx={{ fontSize: 13, color: "text.secondary", minWidth: 0, display: { xs: "none", md: "block" } }}>
          {workspace}
        </Typography>
      </Box>

      <ButtonBase
        onClick={() => setQuickOpen(true)}
        aria-label={t("open by name")}
        sx={{
          height: 32,
          px: 1.25,
          gap: 1,
          justifyContent: "flex-start",
          borderRadius: 2,
          border: 1,
          borderColor: "divider",
          bgcolor: "background.default",
          color: "text.secondary",
          fontSize: 13,
          "&:hover": { borderColor: "text.secondary" },
        }}
      >
        <Search sx={{ fontSize: 18 }} />
        <Box component="span" sx={{ flex: 1, textAlign: "left", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
          {t("Search notebooks, queries and tables")}
        </Box>
        <Box
          component="kbd"
          sx={{ fontFamily: "inherit", fontSize: 11, px: 0.75, py: 0.125, borderRadius: 1, border: 1, borderColor: "divider", color: "text.disabled" }}
        >
          Ctrl K
        </Box>
      </ButtonBase>

      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 0.5 }}>
        <LanguageMenu />
        <ThemeMenu />
        <AccountMenu account={account} />
      </Box>
    </Box>
  );
}
