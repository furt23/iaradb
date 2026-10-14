"use client";

import CheckBox from "@mui/material/Checkbox";
import ClearAll from "@mui/icons-material/ClearAll";
import DeleteOutlined from "@mui/icons-material/DeleteOutlined";
import History from "@mui/icons-material/History";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

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
  return (
    <Box sx={{ width: 280, display: "flex", flexDirection: "column", borderRight: 1, borderColor: "divider", bgcolor: "background.paper" }}>
      <Box sx={{ px: 2, py: 1.5, display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: 1, borderColor: "divider" }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <History fontSize="small" sx={{ color: "primary.main" }} />
          <Typography variant="h4">Applied Steps</Typography>
          <Chip label={steps.length} size="small" variant="outlined" sx={{ height: 20, fontSize: 11 }} />
        </Box>
        {steps.length > 0 && (
          <Tooltip title="Clear all transformation steps">
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
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            0. Source Data
          </Typography>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            Initial
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
                title={step.enabled ? "Disable this step" : "Enable this step"}
              />

              <Box sx={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => onSelectStep(step.id)}>
                <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
                  Step {idx + 1} · {step.op.kind.replace("_", " ")}
                </Typography>
                <Typography variant="body2" noWrap sx={{ fontWeight: 550, fontSize: 12.5 }} title={step.label}>
                  {step.label}
                </Typography>
              </Box>

              <Tooltip title="Delete step">
                <IconButton size="small" onClick={() => onDeleteStep(step.id)} sx={{ opacity: 0.7, "&:hover": { opacity: 1 } }}>
                  <DeleteOutlined fontSize="small" sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            </Box>
          );
        })}

        {steps.length === 0 && (
          <Box sx={{ textAlign: "center", py: 4, px: 2 }}>
            <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mb: 1 }}>
              No steps applied yet.
            </Typography>
            <Typography variant="caption" sx={{ color: "text.disabled", fontSize: 11 }}>
              Use the toolbar above or click on column headers to add filters, clean missing values, or transform text.
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
}
