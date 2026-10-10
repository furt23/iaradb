"use client";

import DarkModeOutlined from "@mui/icons-material/DarkModeOutlined";
import LightModeOutlined from "@mui/icons-material/LightModeOutlined";
import IconButton from "@mui/material/IconButton";
import { useColorScheme } from "@mui/material/styles";
import Tooltip from "@mui/material/Tooltip";

export function ThemeToggle() {
  const { mode, systemMode, setMode } = useColorScheme();
  const current = mode === "system" ? systemMode : mode;
  if (!current) return null; // not hydrated yet
  const next = current === "dark" ? "light" : "dark";
  return (
    <Tooltip title={`Switch to ${next} theme`} placement="right">
      <IconButton onClick={() => setMode(next)} aria-label="toggle theme" sx={{ width: 40, height: 36, borderRadius: 2, color: "text.secondary" }}>
        {current === "dark" ? <LightModeOutlined fontSize="small" /> : <DarkModeOutlined fontSize="small" />}
      </IconButton>
    </Tooltip>
  );
}
