"use client";

import Check from "@mui/icons-material/Check";
import TranslateOutlined from "@mui/icons-material/TranslateOutlined";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Tooltip from "@mui/material/Tooltip";
import { useState } from "react";

import { changeLanguage, type Locale, useTranslation } from "@/i18n";

const LANGUAGES: { code: Locale; label: string }[] = [
  { code: "pt", label: "Português" },
  { code: "en", label: "English" },
];

/** The language selector: Portuguese or English. */
export function LanguageMenu() {
  const { i18n, t } = useTranslation();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const current = (i18n.language?.startsWith("pt") ? "pt" : "en") as Locale;

  return (
    <>
      <Tooltip title={t("Language")}>
        <IconButton
          onClick={(e) => setAnchor(e.currentTarget)}
          aria-label={t("Language")}
          sx={{ color: "text.secondary" }}
        >
          <TranslateOutlined fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { minWidth: 160, mt: 0.5 } } }}
      >
        {LANGUAGES.map((lang) => (
          <MenuItem
            key={lang.code}
            selected={current === lang.code}
            onClick={() => {
              void changeLanguage(lang.code);
              setAnchor(null);
            }}
          >
            <ListItemText>{lang.label}</ListItemText>
            {current === lang.code && (
              <ListItemIcon sx={{ minWidth: "auto" }}>
                <Check fontSize="small" sx={{ color: "primary.main" }} />
              </ListItemIcon>
            )}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
