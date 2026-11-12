"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import { useTranslation } from "@/i18n";
import type { IaraKnowledge, IaraStep } from "@/lib/iara/protocol";

import { knowledgeOf } from "./labels";
import { OntologyIcon } from "./OntologyIcon";

function TermChip({ item }: { item: IaraKnowledge }) {
  const { t } = useTranslation();
  const status = item.certified ? t("Certified by the team") : t("Draft: not reviewed yet");
  return (
    <Tooltip
      title={
        <Box sx={{ maxWidth: 280 }}>
          <Typography variant="caption" sx={{ display: "block", fontWeight: 600 }}>
            {item.team} · {status}
          </Typography>
          <Typography variant="caption" sx={{ display: "block" }}>
            {item.description}
          </Typography>
        </Box>
      }
    >
      <Chip
        size="small"
        variant="outlined"
        tabIndex={0}
        label={item.certified ? `${item.team} · ${item.term}` : `${item.team} · ${item.term} (${t("draft")})`}
        // a draft is dashed, so it reads as unfinished without the tooltip
        sx={{ maxWidth: "100%", ...(!item.certified && { borderStyle: "dashed", color: "text.secondary" }) }}
      />
    </Tooltip>
  );
}

/** The ontology terms Iara read for a message, under its text: which team's knowledge the answer drew on. Nothing when she read none. */
export function KnowledgeSources({ steps }: { steps: IaraStep[] | undefined }) {
  const { t } = useTranslation();
  const items = knowledgeOf(steps);
  if (!items.length) return null;
  return (
    <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 0.5, minWidth: 0 }}>
      <Tooltip title={t("Iara read these terms of the ontology for this answer")}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, color: "primary.main", mr: 0.25 }}>
          <OntologyIcon sx={{ fontSize: 16 }} />
          <Typography variant="caption" sx={{ fontWeight: 600, color: "inherit" }}>
            {t("Ontology")}
          </Typography>
        </Box>
      </Tooltip>
      {items.map((item) => (
        <TermChip key={`${item.team}\n${item.term}`} item={item} />
      ))}
    </Box>
  );
}
