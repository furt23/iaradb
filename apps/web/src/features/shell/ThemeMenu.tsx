"use client";

import Check from "@mui/icons-material/Check";
import DarkModeOutlined from "@mui/icons-material/DarkModeOutlined";
import LightModeOutlined from "@mui/icons-material/LightModeOutlined";
import SettingsBrightnessOutlined from "@mui/icons-material/SettingsBrightnessOutlined";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import { useColorScheme } from "@mui/material/styles";
import Tooltip from "@mui/material/Tooltip";
import { useState, type ReactNode } from "react";

import { useTranslation } from "@/i18n";

type Mode = "light" | "dark" | "system";

const MODES: { mode: Mode; labelKey: string; icon: ReactNode }[] = [
  { mode: "light", labelKey: "Light", icon: <LightModeOutlined fontSize="small" /> },
  { mode: "dark", labelKey: "Dark", icon: <DarkModeOutlined fontSize="small" /> },
  { mode: "system", labelKey: "Match the system", icon: <SettingsBrightnessOutlined fontSize="small" /> },
];

/** The theme: light, dark, or the system's. */
export function ThemeMenu() {
  const { mode, systemMode, setMode } = useColorScheme();
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const shown = mode === "system" ? systemMode : mode;
  if (!mode || !shown) return null; // not hydrated yet
  return (
    <>
      <Tooltip title={t("Theme")}>
        <IconButton onClick={(e) => setAnchor(e.currentTarget)} aria-label={t("Theme")} sx={{ color: "text.secondary" }}>
          {shown === "dark" ? <DarkModeOutlined fontSize="small" /> : <LightModeOutlined fontSize="small" />}
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { minWidth: 200, mt: 0.5 } } }}
      >
        {MODES.map((m) => (
          <MenuItem
            key={m.mode}
            selected={mode === m.mode}
            onClick={() => {
              setMode(m.mode);
              setAnchor(null);
            }}
          >
            <ListItemIcon>{m.icon}</ListItemIcon>
            <ListItemText>{t(m.labelKey)}</ListItemText>
            {mode === m.mode && <Check fontSize="small" sx={{ ml: 2, color: "primary.main" }} />}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
