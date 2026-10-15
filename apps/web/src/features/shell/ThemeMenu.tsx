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

type Mode = "light" | "dark" | "system";

const MODES: { mode: Mode; label: string; icon: ReactNode }[] = [
  { mode: "light", label: "Light", icon: <LightModeOutlined fontSize="small" /> },
  { mode: "dark", label: "Dark", icon: <DarkModeOutlined fontSize="small" /> },
  { mode: "system", label: "Match the system", icon: <SettingsBrightnessOutlined fontSize="small" /> },
];

/** The theme: light, dark, or the system's. */
export function ThemeMenu() {
  const { mode, systemMode, setMode } = useColorScheme();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const shown = mode === "system" ? systemMode : mode;
  if (!mode || !shown) return null; // not hydrated yet
  return (
    <>
      <Tooltip title="Theme">
        <IconButton onClick={(e) => setAnchor(e.currentTarget)} aria-label="theme" sx={{ color: "text.secondary" }}>
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
            <ListItemText>{m.label}</ListItemText>
            {mode === m.mode && <Check fontSize="small" sx={{ ml: 2, color: "primary.main" }} />}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
