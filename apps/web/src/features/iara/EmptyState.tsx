"use client";

import ArrowForwardRounded from "@mui/icons-material/ArrowForwardRounded";
import DescriptionOutlined from "@mui/icons-material/DescriptionOutlined";
import InsertChartOutlined from "@mui/icons-material/InsertChartOutlined";
import SpeedOutlined from "@mui/icons-material/SpeedOutlined";
import TableChartOutlined from "@mui/icons-material/TableChartOutlined";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import { alpha } from "@mui/material/styles";
import { IaraMark } from "@iara/ui";

import { useTranslation } from "@/i18n";
import type { IaraSurface } from "@/lib/iara/protocol";

/** A suggested first prompt: what it asks, what comes back, and its icon. */
interface Example {
  text: string;
  hint: string;
  Icon: typeof TableChartOutlined;
}

const EXAMPLES: Record<IaraSurface, Example[]> = {
  notebook: [
    { text: "Which tables can I use?", hint: "See what is in your catalog", Icon: TableChartOutlined },
    { text: "Explain this notebook", hint: "A summary of each cell", Icon: DescriptionOutlined },
    { text: "Add a cell that charts sales by month", hint: "Iara writes it, you approve", Icon: InsertChartOutlined },
  ],
  sql: [
    { text: "Which tables can I use?", hint: "See what is in your catalog", Icon: TableChartOutlined },
    { text: "Explain this query", hint: "What it reads and returns", Icon: DescriptionOutlined },
    { text: "Make this query faster", hint: "Suggestions you can apply", Icon: SpeedOutlined },
  ],
};

/** A new conversation: a hello and three prompts that fill the composer. */
export function EmptyState({ surface, onPick }: { surface: IaraSurface; onPick(text: string): void }) {
  const { t } = useTranslation();
  return (
    <Box sx={{ m: "auto", p: 2, display: "flex", flexDirection: "column", alignItems: "center", gap: 1.5, textAlign: "center" }}>
      <IaraMark size={48} />
      <Typography sx={{ fontWeight: 650 }}>{t("Hi, I'm Iara.")}</Typography>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        {t("Ask me about your data, or have me write and run the code.")}
      </Typography>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75, alignSelf: "stretch" }}>
        {EXAMPLES[surface].map(({ text, hint, Icon }) => (
          <ButtonBase
            key={text}
            onClick={() => onPick(t(text))}
            sx={{
              width: "100%",
              display: "flex",
              justifyContent: "flex-start",
              alignItems: "center",
              gap: 1.25,
              px: 1.5,
              py: 1.25,
              borderRadius: 2,
              border: 1,
              borderColor: "divider",
              bgcolor: "background.paper",
              textAlign: "left",
              transition: "border-color 150ms, background-color 150ms",
              "&:hover": { borderColor: "primary.main", bgcolor: "action.hover", "& .arrow": { transform: "translateX(2px)", color: "primary.main" } },
            }}
          >
            <Box sx={{ width: 30, height: 30, borderRadius: 1.5, display: "grid", placeItems: "center", flexShrink: 0, color: "primary.main", bgcolor: (theme) => alpha(theme.palette.primary.main, 0.12) }}>
              <Icon sx={{ fontSize: 18 }} />
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 600, color: "text.primary" }}>
                {t(text)}
              </Typography>
              <Typography variant="caption" sx={{ display: "block", color: "text.secondary" }}>
                {t(hint)}
              </Typography>
            </Box>
            <ArrowForwardRounded className="arrow" sx={{ fontSize: 16, flexShrink: 0, color: "text.disabled", transition: "transform 150ms, color 150ms" }} />
          </ButtonBase>
        ))}
      </Box>
    </Box>
  );
}
