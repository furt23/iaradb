"use client";

import Close from "@mui/icons-material/Close";
import KeyboardArrowDown from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUp from "@mui/icons-material/KeyboardArrowUp";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

import { useTranslation } from "@/i18n";

import type { FindOptions } from "./find";
import type { NotebookFind } from "./useNotebookFind";

const field = { flex: 1, minWidth: 0, "& .MuiInputBase-root": { fontSize: 13, pr: 0.75 }, "& .MuiInputBase-input": { py: 0.625 } };
const adornment = { gap: 0.5, ml: 0.5 };

/**
 * Find and replace across the notebook's cells (Ctrl+F): a small box at the
 * top right of the cells. It sits in a sticky row with no height, so it floats
 * over the cells and stays in view while they scroll.
 */
export function FindBar({ find }: { find: NotebookFind }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [find.focuses]);
  if (!find.open) return null;

  const { options } = find;
  const status = options.text ? (find.count ? `${find.current + 1}/${find.count}` : t("No results")) : "";
  const onKeyDown = (enter: () => void) => (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      enter();
    } else if (e.key === "Escape") find.close();
  };
  const toggle = (key: "matchCase" | "regex" | "word", label: string, text: ReactNode) => (
    <Tooltip title={label}>
      <ToggleButton
        value={key}
        selected={options[key]}
        onChange={() => find.update({ ...options, [key]: !options[key] } as FindOptions)}
        aria-label={label}
        size="small"
        sx={{
          border: 0,
          borderRadius: 0.75,
          height: 22,
          minWidth: 24,
          px: 0.5,
          py: 0,
          fontFamily: "monospace",
          fontSize: 12,
          textTransform: "none",
          // an option that is on stands out
          "&.Mui-selected": { bgcolor: "secondary.main", color: "secondary.contrastText", "&:hover": { bgcolor: "secondary.dark" } },
        }}
      >
        {text}
      </ToggleButton>
    </Tooltip>
  );
  const icon = (label: string, content: ReactNode, onClick: () => void, disabled = false) => (
    <Tooltip title={label}>
      <span>
        <IconButton size="small" color="inherit" disabled={disabled} onClick={onClick} aria-label={label}>
          {content}
        </IconButton>
      </span>
    </Tooltip>
  );
  const replace = (label: string, onClick: () => void) => (
    <Button
      color="inherit"
      size="small"
      disabled={!find.count}
      onClick={onClick}
      sx={{ height: 22, minWidth: 0, px: 0.75, fontSize: 12, whiteSpace: "nowrap", bgcolor: "action.hover" }}
    >
      {label}
    </Button>
  );

  return (
    <Box sx={{ position: "sticky", top: 8, height: 0, zIndex: 3, display: "flex", justifyContent: "flex-end", alignItems: "flex-start" }}>
      <Box
        sx={{
          width: 480,
          maxWidth: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 1,
          p: 1,
          bgcolor: "background.paper",
          border: 1,
          borderColor: "divider",
          borderRadius: 1.5,
          boxShadow: 4,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          <TextField
            size="small"
            inputRef={input}
            placeholder={t("Find")}
            value={options.text}
            error={find.invalid}
            onChange={(e) => find.update({ ...options, text: e.target.value })}
            onKeyDown={onKeyDown(() => find.go(1))}
            slotProps={{
              htmlInput: { "aria-label": t("Find") },
              input: {
                endAdornment: (
                  <InputAdornment position="end" sx={adornment}>
                    <Typography variant="caption" aria-live="polite" noWrap sx={{ mr: 0.5, color: "text.secondary" }}>
                      {status}
                    </Typography>
                    {toggle("matchCase", t("Match case"), "Aa")}
                    {toggle("regex", t("Regular expression"), ".*")}
                    {toggle("word", t("Whole word"), <u>ab</u>)}
                  </InputAdornment>
                ),
              },
            }}
            sx={field}
          />
          {icon(t("Previous match"), <KeyboardArrowUp fontSize="small" />, () => find.go(-1), !find.count)}
          {icon(t("Next match"), <KeyboardArrowDown fontSize="small" />, () => find.go(1), !find.count)}
          {icon(t("Close"), <Close fontSize="small" />, find.close)}
        </Box>
        <TextField
          size="small"
          placeholder={t("Replace with")}
          value={find.replacement}
          onChange={(e) => find.setReplacement(e.target.value)}
          onKeyDown={onKeyDown(find.replaceOne)}
          slotProps={{
            htmlInput: { "aria-label": t("Replace with") },
            input: {
              endAdornment: (
                <InputAdornment position="end" sx={adornment}>
                  {replace(t("Replace"), find.replaceOne)}
                  {replace(t("Replace all"), find.replaceEverywhere)}
                </InputAdornment>
              ),
            },
          }}
          sx={field}
        />
      </Box>
    </Box>
  );
}
