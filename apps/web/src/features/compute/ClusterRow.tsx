"use client";

import ContentCopyOutlined from "@mui/icons-material/ContentCopyOutlined";
import DeleteOutline from "@mui/icons-material/DeleteOutlineOutlined";
import EditOutlined from "@mui/icons-material/EditOutlined";
import PlayArrow from "@mui/icons-material/PlayArrow";
import StopOutlined from "@mui/icons-material/StopOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";

import { useGuard } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { formatMinutes, minutesSince } from "@/lib/clusterTime";
import { setDefaultCluster } from "@/server/actions/clusters";
import type { ClusterView } from "@/server/compute/types";

import { machineSummary, StateChip } from "./ClusterState";

export interface ClusterActions {
  start(c: ClusterView): void;
  terminate(c: ClusterView): void;
  edit(c: ClusterView): void;
  remove(c: ClusterView): void;
  clone(c: ClusterView): void;
}

/** One cluster: state, machine, limits, attached notebooks and its actions. */
export function ClusterRow({ cluster: c, now, actions, cloud }: { cluster: ClusterView; now: number; actions: ClusterActions; cloud: boolean }) {
  const { t } = useTranslation();
  const guard = useGuard();
  const router = useRouter();
  const makeDefault = () =>
    guard(async () => {
      unwrap(await setDefaultCluster(c.id));
      router.refresh();
    });
  const stopped = c.state === "terminated" || c.state === "error";
  const details = [machineSummary(c)];
  if (c.kind === "ec2") details.push(t("terminates after {{n}} min idle", { n: c.autoTerminateMinutes }));
  if (c.kind === "ec2" && c.maxHours) details.push(t("limit {{n}} h", { n: c.maxHours }));
  if (c.owner) details.push(t("by {{owner}}", { owner: c.owner }));
  if (c.kind === "ec2" && c.state === "running") {
    details.push(
      t("up {{time}}", { time: formatMinutes(minutesSince(c.startedAt, now) ?? 0) }),
      t("idle {{time}}", { time: formatMinutes(minutesSince(c.lastActivity, now) ?? 0) }),
    );
  }
  const notebooks = c.notebooks.length;
  return (
    <Paper variant="outlined" sx={{ p: 2, display: "flex", alignItems: "center", gap: 2 }} aria-label={`cluster ${c.name}`}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
          <Typography
            component={Link}
            href={`/compute/${encodeURIComponent(c.id)}`}
            sx={{ fontWeight: 650, color: "text.primary", textDecoration: "none", "&:hover": { textDecoration: "underline" } }}
          >
            {c.name}
          </Typography>
          {c.isDefault && <Chip size="small" label={t("default")} />}
          {c.job && <Chip size="small" variant="outlined" label={t("job run")} title={t("Terminated when the run ends")} />}
          {c.spot && <Chip size="small" variant="outlined" color="info" label={t("spot")} title={t("AWS may reclaim this machine")} />}
          {c.state === "running" && c.spot && c.runningSpot === false && <Chip size="small" variant="outlined" label={t("on-demand")} />}
          <StateChip cluster={c} />
        </Box>
        <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>
          {details.join(" · ")}
        </Typography>
        {c.error && (
          <Typography variant="body2" sx={{ color: "error.main", mt: 0.5, overflowWrap: "anywhere" }}>
            {c.error}
          </Typography>
        )}
        <Tooltip title={c.notebooks.join("\n") || t("no notebook attached")}>
          <Typography variant="caption" sx={{ color: "text.disabled" }}>
            {notebooks === 1 ? t("{{n}} notebook attached", { n: notebooks }) : t("{{n}} notebooks attached", { n: notebooks })}
          </Typography>
        </Tooltip>
        {c.libraries && c.libraries.length > 0 && (
          <Typography variant="caption" sx={{ display: "block", color: "text.secondary", fontFamily: "monospace", overflowWrap: "anywhere" }}>
            {t("Libraries")}: {c.libraries.join(", ")}
          </Typography>
        )}
      </Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexShrink: 0 }}>
        {!c.isDefault && !c.job && (
          <Button size="small" onClick={makeDefault}>
            {t("Make default")}
          </Button>
        )}
        {c.kind === "ec2" && (
          <>
          {stopped ? (
            <Button variant="contained" size="small" startIcon={<PlayArrow />} onClick={() => actions.start(c)} disabled={!cloud}>
              {t("Start")}
            </Button>
          ) : (
            <Button variant="outlined" size="small" color="error" startIcon={<StopOutlined />} onClick={() => actions.terminate(c)} disabled={c.state === "terminating"}>
              {t("Terminate")}
            </Button>
          )}
          <Tooltip title={t("Clone")}>
            <IconButton onClick={() => actions.clone(c)} aria-label={`clone ${c.name}`}>
              <ContentCopyOutlined fontSize="small" />
            </IconButton>
          </Tooltip>
          {c.canManage && (
            <>
              <Tooltip title={t("Edit")}>
                <IconButton onClick={() => actions.edit(c)} aria-label={`edit ${c.name}`}>
                  <EditOutlined fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title={stopped ? t("Delete") : t("Terminate it first")}>
                <span>
                  <IconButton onClick={() => actions.remove(c)} disabled={!stopped} aria-label={`delete ${c.name}`}>
                    <DeleteOutline fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </>
          )}
          </>
        )}
      </Box>
    </Paper>
  );
}
