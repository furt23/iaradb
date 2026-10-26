"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { LogoMark } from "@iara/ui";
import Link from "next/link";
import { useTranslation } from "react-i18next";

/** The viewer's top bar: the brand (back to the list), who is signed in, and signing out. */
export function ViewBar({ email, signOut }: { email: string; signOut: boolean }) {
  const { t } = useTranslation();
  return (
    <Box
      component="header"
      sx={{ height: 48, flexShrink: 0, display: "flex", alignItems: "center", gap: 2, px: 1.5, borderBottom: 1, borderColor: "divider", bgcolor: "background.paper" }}
    >
      <Box
        component={Link}
        href="/view"
        aria-label={t("Shared dashboards")}
        sx={{ display: "flex", alignItems: "center", gap: 1, color: "text.primary", textDecoration: "none" }}
      >
        <LogoMark size={24} />
        <Typography variant="h3" component="span" sx={{ fontSize: 17, lineHeight: 1 }}>
          Iara
        </Typography>
      </Box>
      <Box sx={{ flex: 1 }} />
      {email && (
        <Typography noWrap sx={{ fontSize: 13, color: "text.secondary", minWidth: 0, display: { xs: "none", sm: "block" } }}>
          {email}
        </Typography>
      )}
      {/* a plain link: a client-side navigation (or prefetch) must not hit the sign-out route */}
      {signOut && (
        <Button component="a" href="/auth/logout">
          {t("Sign out")}
        </Button>
      )}
    </Box>
  );
}
