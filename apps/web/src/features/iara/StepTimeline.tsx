"use client";

import DescriptionOutlined from "@mui/icons-material/DescriptionOutlined";
import ExpandMore from "@mui/icons-material/ExpandMore";
import FactCheckOutlined from "@mui/icons-material/FactCheckOutlined";
import FolderOutlined from "@mui/icons-material/FolderOutlined";
import PlayArrowOutlined from "@mui/icons-material/PlayArrowOutlined";
import PsychologyOutlined from "@mui/icons-material/PsychologyOutlined";
import SearchRounded from "@mui/icons-material/SearchRounded";
import TableChartOutlined from "@mui/icons-material/TableChartOutlined";
import TableRowsOutlined from "@mui/icons-material/TableRowsOutlined";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import Typography from "@mui/material/Typography";
import { useState, type ReactNode } from "react";

import { useTranslation } from "@/i18n";
import type { IaraAgent, IaraStep } from "@/lib/iara/protocol";

import { ChatMarkdown } from "./ChatMarkdown";
import { AGENT_LABEL, AGENT_NAME, thoughtParts, toolLabel } from "./labels";

// one line of body2 text: the dot sits on its middle
const LINE = 20;

/** The icon of a data tool, by what it does. */
function ToolIcon({ tool }: { tool: string }) {
  const sx = { fontSize: 14, color: "text.secondary", flexShrink: 0 };
  switch (tool) {
    case "list_tables":
      return <TableRowsOutlined sx={sx} />;
    case "describe_table":
      return <TableChartOutlined sx={sx} />;
    case "run_sql":
      return <PlayArrowOutlined sx={sx} />;
    case "explain_sql":
      return <FactCheckOutlined sx={sx} />;
    case "list_files":
      return <FolderOutlined sx={sx} />;
    case "read_file":
      return <DescriptionOutlined sx={sx} />;
    default:
      return <SearchRounded sx={sx} />;
  }
}

/** One row: its rail (the dot, if any, and the line down to the next row) beside its content. */
function Row({ dot, last, children }: { dot?: ReactNode; last: boolean; children: ReactNode }) {
  return (
    <Box sx={{ display: "flex", gap: 1, minWidth: 0 }}>
      <Box sx={{ width: 16, flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center" }}>
        {dot}
        {!last && <Box sx={{ width: "1px", flex: 1, bgcolor: "divider" }} />}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0, pb: last ? 0 : 0.5 }}>{children}</Box>
    </Box>
  );
}

/** A step's dot: a thought is tinted, and the last step of a live message pulses. */
function Dot({ thought, pulse }: { thought: boolean; pulse: boolean }) {
  return (
    <Box sx={{ height: LINE, display: "flex", alignItems: "center", flexShrink: 0 }}>
      <Box
        sx={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          bgcolor: thought ? "primary.main" : "text.disabled",
          opacity: thought ? 0.7 : 1,
          ...(pulse && { animation: "iara-pulse 1.2s ease-in-out infinite", "@keyframes iara-pulse": { "50%": { opacity: 0.35 } } }),
        }}
      />
    </Box>
  );
}

function AgentCaption({ agent }: { agent: IaraAgent }) {
  const { t } = useTranslation();
  return (
    <Typography variant="caption" sx={{ display: "block", color: "text.disabled", textTransform: "uppercase", letterSpacing: "0.04em", fontSize: 10.5 }}>
      {t(AGENT_NAME[agent])}
    </Typography>
  );
}

function ToolRow({ step }: { step: Extract<IaraStep, { kind: "tool" }> }) {
  const { t } = useTranslation();
  const label = toolLabel(step);
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, height: LINE, minWidth: 0 }}>
      <ToolIcon tool={step.tool} />
      <Typography variant="body2" noWrap sx={{ color: "text.secondary", minWidth: 0 }}>
        {t(label.key, label.values)}
      </Typography>
    </Box>
  );
}

/** A thought: its heading, and its body under a click. A thought without a body has no toggle. */
function ThoughtRow({ text, startOpen }: { text: string; startOpen: boolean }) {
  const { t } = useTranslation();
  const { title, body } = thoughtParts(text);
  const [open, setOpen] = useState(startOpen);
  const sx = { display: "flex", alignItems: "center", gap: 0.75, height: LINE, minWidth: 0, width: "100%", justifyContent: "flex-start", textAlign: "left", color: "text.secondary" };
  const head = (
    <>
      <PsychologyOutlined sx={{ fontSize: 14, flexShrink: 0 }} />
      <Typography variant="body2" noWrap sx={{ fontWeight: 500, minWidth: 0 }}>
        {title ?? t("Thinking")}
      </Typography>
    </>
  );
  return (
    <Box sx={{ minWidth: 0 }}>
      {body ? (
        <ButtonBase onClick={() => setOpen(!open)} aria-expanded={open} sx={{ ...sx, "&:hover": { color: "text.primary" } }}>
          {head}
        </ButtonBase>
      ) : (
        <Box sx={sx}>{head}</Box>
      )}
      {body && (
        <Collapse in={open}>
          <Box sx={{ color: "text.secondary", pt: 0.5 }}>
            <ChatMarkdown text={body} size={13} />
          </Box>
        </Collapse>
      )}
    </Box>
  );
}

/** A timeline row: an agent's caption, or a step. */
type Entry = { key: string; caption: IaraAgent } | { key: string; step: IaraStep };

/**
 * What Iara did on a message, as a timeline: each agent's steps under its name,
 * tools and the model's thoughts. Open while the message is being written, closed
 * after; the user's click wins.
 */
export function StepTimeline({ steps, live, agent }: { steps: IaraStep[]; live: boolean; agent: IaraAgent | null }) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? live;

  const entries: Entry[] = [];
  steps.forEach((step, i) => {
    if (i === 0 || step.agent !== steps[i - 1].agent) entries.push({ key: `c${i}`, caption: step.agent });
    entries.push({ key: `s${i}`, step });
  });
  const newest = steps.filter((s) => s.kind === "thought").at(-1);

  return (
    <Box sx={{ minWidth: 0 }}>
      <ButtonBase
        onClick={() => setChoice(!open)}
        aria-expanded={open}
        sx={{ width: "100%", justifyContent: "flex-start", textAlign: "left", gap: 0.5, color: "text.secondary", "&:hover": { color: "text.primary" }, transition: "color 150ms" }}
      >
        <ExpandMore sx={{ fontSize: 16, flexShrink: 0, transform: open ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 150ms" }} />
        {live && <CircularProgress size={10} color="inherit" />}
        <Typography variant="body2">{live ? `${t(AGENT_LABEL[agent ?? "iara"])}…` : t("Steps ({{count}})", { count: String(steps.length) })}</Typography>
      </ButtonBase>
      <Collapse in={open}>
        <Box sx={{ pt: 0.75 }}>
          {entries.map((entry, i) => {
            const last = i === entries.length - 1;
            if ("caption" in entry) {
              return (
                <Row key={entry.key} last={last}>
                  <AgentCaption agent={entry.caption} />
                </Row>
              );
            }
            const { step } = entry;
            return (
              <Row key={entry.key} last={last} dot={<Dot thought={step.kind === "thought"} pulse={live && last} />}>
                {step.kind === "tool" ? <ToolRow step={step} /> : <ThoughtRow text={step.text} startOpen={live && step === newest} />}
              </Row>
            );
          })}
        </Box>
      </Collapse>
    </Box>
  );
}
