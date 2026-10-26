"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { alpha } from "@mui/material/styles";
import { IaraMark } from "@iara/ui";
import { useState } from "react";

import { useTranslation } from "@/i18n";

import type { IaraDecide } from "./types";

/** The strip over code Iara proposes to change: keep the change (and run it), or undo it. */
export function ReviewBar({ decide, canRun }: { decide: IaraDecide; canRun: boolean }) {
  const { t } = useTranslation();
  const [answered, setAnswered] = useState(false);
  const answer = (respond: () => void) => () => {
    setAnswered(true);
    respond();
  };
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        px: 1.5,
        py: 0.5,
        borderBottom: 1,
        borderColor: "divider",
        bgcolor: (theme) => alpha(theme.palette.secondary.main, 0.08),
      }}
    >
      <IaraMark size={18} />
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {t("Iara suggests a change")}
      </Typography>
      <Box sx={{ flex: 1 }} />
      {canRun && (
        <Button size="small" variant="contained" color="secondary" disabled={answered} onClick={answer(() => decide.keep(true))}>
          {t("Keep and run")}
        </Button>
      )}
      <Button size="small" disabled={answered} onClick={answer(() => decide.keep(false))}>
        {t("Keep")}
      </Button>
      <Button size="small" color="inherit" disabled={answered} onClick={answer(() => decide.undo())}>
        {t("Undo")}
      </Button>
    </Box>
  );
}
