"use client";

import CodeOutlined from "@mui/icons-material/CodeOutlined";
import DescriptionOutlined from "@mui/icons-material/DescriptionOutlined";
import FactCheckOutlined from "@mui/icons-material/FactCheckOutlined";
import StorageOutlined from "@mui/icons-material/StorageOutlined";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import { alpha } from "@mui/material/styles";

import { useTranslation } from "@/i18n";

export type AgentSection = "instructions" | "tables" | "examples" | "evals";

const ITEMS: { id: AgentSection; label: string; Icon: typeof CodeOutlined }[] = [
  { id: "instructions", label: "Instructions", Icon: DescriptionOutlined },
  { id: "tables", label: "Tables", Icon: StorageOutlined },
  { id: "examples", label: "SQL examples", Icon: CodeOutlined },
  { id: "evals", label: "Evaluations", Icon: FactCheckOutlined },
];

/** The builder's compact vertical rail, on the right (the app's own rail is on the left): one button per section, with a count where it has one. */
export function AgentRail({ value, onChange, counts }: { value: AgentSection; onChange(next: AgentSection): void; counts: Partial<Record<AgentSection, number>> }) {
  const { t } = useTranslation();
  return (
    <Box
      component="nav"
      aria-label={t("Agent sections")}
      sx={{ width: 80, flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 1, py: 1.5, borderLeft: 1, borderColor: "divider", bgcolor: "background.paper" }}
    >
      {ITEMS.map(({ id, label, Icon }) => {
        const active = id === value;
        const count = counts[id];
        return (
          <ButtonBase
            key={id}
            aria-current={active ? "page" : undefined}
            onClick={() => onChange(id)}
            sx={{
              position: "relative",
              width: 64,
              py: 1.25,
              px: 0.5,
              borderRadius: 2,
              display: "flex",
              flexDirection: "column",
              gap: 0.5,
              border: 1,
              borderColor: active ? (theme) => alpha(theme.palette.primary.main, 0.3) : "transparent",
              color: active ? "primary.main" : "text.secondary",
              bgcolor: active ? (theme) => alpha(theme.palette.primary.main, 0.12) : "transparent",
              "&:hover": { bgcolor: active ? undefined : "action.hover", color: active ? undefined : "text.primary" },
            }}
          >
            {count !== undefined && (
              <Box
                component="span"
                sx={{ position: "absolute", top: 4, right: 6, fontSize: 9, fontWeight: 700, px: 0.5, borderRadius: 0.75, border: 1, borderColor: "divider", bgcolor: "background.default", color: "text.secondary", lineHeight: 1.5 }}
              >
                {count}
              </Box>
            )}
            <Icon sx={{ fontSize: 18 }} />
            <Typography component="span" sx={{ fontSize: 10, fontWeight: 500, lineHeight: 1.2, textAlign: "center" }}>
              {t(label)}
            </Typography>
          </ButtonBase>
        );
      })}
    </Box>
  );
}
