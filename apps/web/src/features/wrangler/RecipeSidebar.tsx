"use client";

import CheckBox from "@mui/material/Checkbox";
import ClearAll from "@mui/icons-material/ClearAll";
import DeleteOutlined from "@mui/icons-material/DeleteOutlined";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";

import type { WranglerStep } from "./types";

interface Props {
  steps: WranglerStep[];
  activeStepId: string | null;
  onSelectStep: (id: string | null) => void;
  onToggleStep: (id: string) => void;
  onDeleteStep: (id: string) => void;
  onClearSteps: () => void;
}

export function RecipeSidebar({ steps, activeStepId, onSelectStep, onToggleStep, onDeleteStep, onClearSteps }: Props) {
  const { t } = useTranslation();
  return (
    <Box sx={{ width: 240, display: "flex", flexDirection: "column", borderRight: 1, borderColor: "divider", bgcolor: "background.paper" }}>
      <Box sx={{ px: 2, py: 1, display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: 1, borderColor: "divider" }}>
        <Typography variant="overline" sx={{ color: "text.secondary" }}>
          {t("Steps")}{steps.length > 0 && ` · ${steps.length}`}
        </Typography>
        {steps.length > 0 && (
          <Tooltip title={t("Clear all steps")}>
            <IconButton size="small" onClick={onClearSteps}>
              <ClearAll fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Box>

      <Box sx={{ flex: 1, overflow: "auto", p: 1, display: "flex", flexDirection: "column", gap: 0.75 }}>
        {/* Source / Initial State */}
        <Box
          onClick={() => onSelectStep(null)}
          sx={{
            px: 1.5,
            py: 1,
            borderRadius: 1,
            cursor: "pointer",
            border: 1,
            borderColor: activeStepId === null ? "primary.main" : "transparent",
            bgcolor: activeStepId === null ? "action.selected" : "transparent",
            "&:hover": { bgcolor: "action.hover" },
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Typography variant="body2" sx={{ fontWeight: 500 }}>
            {t("Source")}
          </Typography>
        </Box>

        {steps.map((step, idx) => {
          const isActive = activeStepId === step.id;
          return (
            <Box
              key={step.id}
              sx={{
                px: 1,
                py: 0.5,
                borderRadius: 1,
                border: 1,
                borderColor: isActive ? "primary.main" : "divider",
                bgcolor: isActive ? "action.selected" : "background.default",
                opacity: step.enabled ? 1 : 0.5,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 0.5,
                transition: "all 120ms ease",
              }}
            >
              <CheckBox
                size="small"
                checked={step.enabled}
                onChange={() => onToggleStep(step.id)}
                sx={{ p: 0.5 }}
                title={step.enabled ? t("Disable this step") : t("Enable this step")}
              />

              <Box sx={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => onSelectStep(step.id)}>
                <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
                  {t("Step {{number}} · {{kind}}", { number: idx + 1, kind: step.op.kind.replaceAll("_", " ") })}
                </Typography>
                <Typography variant="body2" noWrap sx={{ fontWeight: 550, fontSize: 12.5 }} title={step.label}>
                  {step.label}
                </Typography>
              </Box>

              <Tooltip title={t("Delete step")}>
                <IconButton size="small" onClick={() => onDeleteStep(step.id)} sx={{ opacity: 0.7, "&:hover": { opacity: 1 } }}>
                  <DeleteOutlined fontSize="small" sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            </Box>
          );
        })}

      </Box>
    </Box>
  );
}
