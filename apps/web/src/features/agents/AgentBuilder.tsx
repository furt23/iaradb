"use client";

import CircularProgress from "@mui/material/CircularProgress";
import Box from "@mui/material/Box";
import { useEffect, useState } from "react";

import { ErrorState } from "@/features/shell/PageHeader";
import { useTranslation } from "@/i18n";
import type { Agent } from "@/lib/agents/types";
import { openAgentAction } from "@/server/actions/agents";

import { AgentEditor } from "./AgentEditor";

/** The builder of the agent `slug`: its instructions, tables, examples, tests and a test chat. */
export function AgentBuilder({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState<Agent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void openAgentAction(slug).then((r) => {
      if (!current) return;
      if (r.ok) setOpened(r.data);
      else setError(r.error.message);
    });
    return () => {
      current = false;
    };
  }, [slug]);

  if (error) return <ErrorState title={t("Could not open the agent")} message={error} />;
  if (opened?.slug !== slug) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", pt: 8 }}>
        <CircularProgress size={22} />
      </Box>
    );
  }
  return <AgentEditor key={slug} slug={slug} opened={opened} />;
}
