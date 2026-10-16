"use client";

import Add from "@mui/icons-material/Add";
import Close from "@mui/icons-material/Close";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { pipSpecMessage } from "./pipSpecMessage";

/** pip requirement specs of a cluster: a field that adds one (Enter too), then the list to remove from. */
export function LibrariesEditor({ value, onChange }: { value: string[]; onChange(next: string[]): void }) {
  const { t } = useTranslation();
  const [spec, setSpec] = useState("");
  const trimmed = spec.trim();
  const error = pipSpecMessage(spec, t);

  const add = () => {
    if (!trimmed || error) return;
    setSpec("");
    if (!value.includes(trimmed)) onChange([...value, trimmed]);
  };

  return (
    <Stack spacing={1.5}>
      <Box>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <TextField
            size="small"
            label={t("Library")}
            placeholder="polars==1.9"
            value={spec}
            error={Boolean(error)}
            onChange={(e) => setSpec(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            fullWidth
          />
          <Button startIcon={<Add />} onClick={add} disabled={!trimmed || Boolean(error)} sx={{ flexShrink: 0 }}>
            {t("Add")}
          </Button>
        </Stack>
        <Typography variant="caption" sx={{ display: "block", mt: 0.5, color: error ? "error.main" : "text.secondary" }}>
          {error ?? t("pip specs, e.g. polars==1.9 or scikit-learn>=1.5")}
        </Typography>
      </Box>
      {value.length > 0 && (
        <List dense disablePadding>
          {value.map((lib) => (
            <ListItem
              key={lib}
              divider
              secondaryAction={
                <IconButton edge="end" size="small" aria-label={t("Remove")} onClick={() => onChange(value.filter((v) => v !== lib))}>
                  <Close fontSize="small" />
                </IconButton>
              }
            >
              <ListItemText primary={lib} slotProps={{ primary: { sx: { fontFamily: "monospace", overflowWrap: "anywhere" } } }} />
            </ListItem>
          ))}
        </List>
      )}
    </Stack>
  );
}
