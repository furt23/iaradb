"use client";

import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Tooltip from "@mui/material/Tooltip";

import { useTranslation } from "@/i18n";
import { formatCompact } from "@/lib/format";
import type { IaraUsage } from "@/lib/iara/protocol";

import { contextPercent } from "./format";

/** A ring of how much of the conversation's room is used; it turns to the warning color past 80%. */
export function TokenMeter({ usage }: { usage: IaraUsage }) {
  const { t } = useTranslation();
  const percent = contextPercent(usage.context, usage.budget);
  const label = t("{{context}} of {{budget}} tokens in this conversation · last answer used {{turnInput}} in, {{turnOutput}} out", {
    context: formatCompact(usage.context),
    budget: formatCompact(usage.budget),
    turnInput: formatCompact(usage.turnInput),
    turnOutput: formatCompact(usage.turnOutput),
  });
  return (
    <Tooltip title={label}>
      <Box role="img" aria-label={label} sx={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
        <CircularProgress variant="determinate" value={100} size={20} thickness={5} sx={{ color: "action.disabledBackground" }} />
        <CircularProgress
          variant="determinate"
          value={percent}
          size={20}
          thickness={5}
          color={percent > 80 ? "warning" : "secondary"}
          sx={{ position: "absolute", left: 0 }}
        />
      </Box>
    </Tooltip>
  );
}
