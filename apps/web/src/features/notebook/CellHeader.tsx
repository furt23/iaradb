"use client";

import AccountTreeOutlined from "@mui/icons-material/AccountTreeOutlined";
import Code from "@mui/icons-material/Code";
import CodeOff from "@mui/icons-material/CodeOff";
import DragIndicator from "@mui/icons-material/DragIndicator";
import PlayArrowRounded from "@mui/icons-material/PlayArrowRounded";
import StopRounded from "@mui/icons-material/StopRounded";
import UnfoldLess from "@mui/icons-material/UnfoldLess";
import UnfoldMore from "@mui/icons-material/UnfoldMore";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import InputBase from "@mui/material/InputBase";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { Cell, CellKind, CellState } from "@iara/protocol";

import { useTranslation } from "@/i18n";
import { CellMenu, type CellMenuProps } from "./CellMenu";
import { CellStatusBadge } from "./CellStatus";
import type { DragHandle } from "./SortableCell";

const KIND_LABEL: Record<CellKind, string> = { python: "Python", sql: "SQL", markdown: "Markdown" };

export interface CellHeaderProps extends CellMenuProps {
  cell: Cell;
  state: CellState;
  stale: boolean;
  /** the notebook runs: the run button stops the whole run instead */
  running: boolean;
  /** the notebook's cluster runs: otherwise the cell has no run button */
  canRun: boolean;
  /** a stop was asked for and the kernel has not stopped yet */
  stopping: boolean;
  dragHandle?: DragHandle;
  onRun(): void;
  onStop(): void;
  onKind(kind: CellKind): void;
  onOutput(name: string): void;
  /** opens the query plans of the last run */
  onPlans(): void;
}

function validName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
}

function Handle({ handle }: { handle: DragHandle }) {
  const { t } = useTranslation();
  return (
    <Tooltip title={t("Drag to move (or focus and press Space, then the arrow keys)")}>
      <Box
        ref={handle.ref}
        {...handle.attributes}
        {...handle.listeners}
        aria-label={t("drag to move the cell")}
        sx={{ display: "flex", color: "text.disabled", cursor: "grab", borderRadius: 1, touchAction: "none", "&:hover": { color: "text.secondary" }, "&:active": { cursor: "grabbing" } }}
      >
        <DragIndicator fontSize="small" />
      </Box>
    </Tooltip>
  );
}

function OutputName({ value, onChange }: { value: string; onChange(v: string): void }) {
  const { t } = useTranslation();
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
      <Typography variant="mono" sx={{ color: "text.disabled", fontSize: 11 }}>
        →
      </Typography>
      <InputBase
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^A-Za-z0-9_]/g, ""))}
        error={!validName(value)}
        inputProps={{ "aria-label": t("result name"), spellCheck: false }}
        sx={{
          fontFamily: "'JetBrains Mono Variable', monospace",
          fontSize: 12,
          color: validName(value) ? "secondary.main" : "error.main",
          width: `${Math.max(4, value.length + 1)}ch`,
        }}
      />
    </Box>
  );
}

export function CellHeader(p: CellHeaderProps) {
  const { t } = useTranslation();
  const plans = (p.state.queries?.length ?? 0) > 0 && p.state.status !== "running";
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, pl: 0.5, pr: 1, height: 36 }}>
      {p.dragHandle && <Handle handle={p.dragHandle} />}
      {p.running ? (
        // one run at a time: whichever cell it is pressed on, it stops the whole run
        <Tooltip title={p.stopping ? t("Stopping…") : t("Stop the run")}>
          <span>
            <IconButton onClick={p.onStop} disabled={p.stopping} aria-label={t("stop the run")} sx={{ color: "error.main" }}>
              {p.stopping ? <CircularProgress size={14} thickness={5} color="inherit" /> : <StopRounded fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
      ) : (
        p.canRun && (
          <Tooltip title={t("Run cell (Shift+Enter)")}>
            <IconButton onClick={p.onRun} aria-label={t("run cell")} sx={{ color: "success.main" }}>
              <PlayArrowRounded fontSize="small" />
            </IconButton>
          </Tooltip>
        )
      )}
      <Select
        value={p.cell.kind}
        onChange={(e) => p.onKind(e.target.value as CellKind)}
        variant="standard"
        disableUnderline
        sx={{ fontSize: 12, fontWeight: 700, color: "text.secondary", "& .MuiSelect-select": { py: 0 } }}
        inputProps={{ "aria-label": t("cell language") }}
      >
        {(Object.keys(KIND_LABEL) as CellKind[]).map((k) => (
          <MenuItem key={k} value={k} sx={{ fontSize: 13 }}>
            {KIND_LABEL[k]}
          </MenuItem>
        ))}
      </Select>
      {p.cell.kind === "sql" && <OutputName value={p.cell.output ?? ""} onChange={p.onOutput} />}
      <Box sx={{ flex: 1 }} />
      <CellStatusBadge status={p.state.status} stale={p.stale} elapsed={p.state.elapsed_ms} />
      <Tooltip title={p.hidden ? t("Show code") : t("Hide code")}>
        <IconButton onClick={p.onToggleHidden} aria-label={p.hidden ? t("show code") : t("hide code")} sx={{ color: p.hidden ? "secondary.main" : "text.disabled" }}>
          {p.hidden ? <Code fontSize="small" /> : <CodeOff fontSize="small" />}
        </IconButton>
      </Tooltip>
      {plans && (
        <Tooltip title={t("Query plans")}>
          <IconButton onClick={p.onPlans} aria-label={t("query plans")} sx={{ color: "text.disabled" }}>
            <AccountTreeOutlined fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
      {p.hasOutput && (
        <Tooltip title={p.outputHidden ? t("Show output") : t("Hide output")}>
          <IconButton onClick={p.onToggleOutput} aria-label={p.outputHidden ? t("show output") : t("hide output")} sx={{ color: p.outputHidden ? "secondary.main" : "text.disabled" }}>
            {p.outputHidden ? <UnfoldMore fontSize="small" /> : <UnfoldLess fontSize="small" />}
          </IconButton>
        </Tooltip>
      )}
      <CellMenu
        hidden={p.hidden}
        hasOutput={p.hasOutput}
        outputHidden={p.outputHidden}
        onMove={p.onMove}
        onToggleHidden={p.onToggleHidden}
        onToggleOutput={p.onToggleOutput}
        onClearOutput={p.onClearOutput}
        onCopyLink={p.onCopyLink}
        onDelete={p.onDelete}
      />
    </Box>
  );
}
