"use client";

import DeleteOutlined from "@mui/icons-material/DeleteOutlined";
import SmartToyOutlined from "@mui/icons-material/SmartToyOutlined";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import Link from "next/link";

import { useTranslation } from "@/i18n";
import { formatRelative } from "@/lib/format";
import type { AgentSummary } from "@/lib/agents/types";

/** A flat row of the agents list. The delete button is a sibling of the link (no button inside a link). */
export function AgentRow({ agent, onDelete }: { agent: AgentSummary; onDelete(): void }) {
  const { t } = useTranslation();
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        borderBottom: 1,
        borderColor: "divider",
        "&:hover, &:focus-within": { bgcolor: "action.hover", "& .agent-delete": { opacity: 1 } },
        "@media (hover: none)": { "& .agent-delete": { opacity: 1 } },
      }}
    >
      <ButtonBase
        component={Link}
        href={`/agents/${agent.slug}`}
        sx={{ flex: 1, minWidth: 0, justifyContent: "flex-start", alignItems: "center", gap: 1.5, px: 1, py: 1.25, textAlign: "left" }}
      >
        <SmartToyOutlined sx={{ fontSize: 20, color: "primary.main", flexShrink: 0 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography noWrap sx={{ fontWeight: 600, fontSize: 14 }}>
            {agent.title}
          </Typography>
          <Typography noWrap sx={{ fontSize: 12.5, color: agent.description ? "text.secondary" : "text.disabled" }}>
            {agent.description || t("No description")}
          </Typography>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0, pl: 2 }}>
          <Typography noWrap sx={{ fontSize: 12, color: "text.secondary" }}>
            {agent.tables === 1 ? t("{{count}} table", { count: agent.tables }) : t("{{count}} tables", { count: agent.tables })}
          </Typography>
          <Typography noWrap title={new Date(agent.updatedAt).toLocaleString()} sx={{ fontSize: 12, color: "text.secondary", minWidth: 64, textAlign: "right" }}>
            {formatRelative(agent.updatedAt)}
          </Typography>
        </Box>
      </ButtonBase>
      <IconButton
        className="agent-delete"
        aria-label={`${t("Delete")} ${agent.title}`}
        onClick={onDelete}
        sx={{ ml: 0.5, opacity: 0 }}
      >
        <DeleteOutlined fontSize="small" />
      </IconButton>
    </Box>
  );
}
