"use client";

import Code from "@mui/icons-material/Code";
import CodeOff from "@mui/icons-material/CodeOff";
import DragIndicator from "@mui/icons-material/DragIndicator";
import PlayArrowRounded from "@mui/icons-material/PlayArrowRounded";
import UnfoldLess from "@mui/icons-material/UnfoldLess";
import UnfoldMore from "@mui/icons-material/UnfoldMore";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import InputBase from "@mui/material/InputBase";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { Cell, CellKind, CellState } from "@workhouse/protocol";

import { CellMenu, type CellMenuProps } from "./CellMenu";
import { CellStatusBadge } from "./CellStatus";
import type { DragHandle } from "./SortableCell";

const KIND_LABEL: Record<CellKind, string> = { python: "Python", sql: "SQL", markdown: "Markdown" };

export interface CellHeaderProps extends CellMenuProps {
  cell: Cell;
  state: CellState;
  stale: boolean;
  disabled: boolean;
  dragHandle?: DragHandle;
  onRun(): void;
  onKind(kind: CellKind): void;
  onOutput(name: string): void;
}

function validName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
}

function Handle({ handle }: { handle: DragHandle }) {
  return (
    <Tooltip title="Drag to move (or focus and press Space, then the arrow keys)">
      <Box
        ref={handle.ref}
        {...handle.attributes}
        {...handle.listeners}
        aria-label="drag to move the cell"
        sx={{ display: "flex", color: "text.disabled", cursor: "grab", borderRadius: 1, touchAction: "none", "&:hover": { color: "text.secondary" }, "&:active": { cursor: "grabbing" } }}
      >
        <DragIndicator fontSize="small" />
      </Box>
    </Tooltip>
  );
}

function OutputName({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
      <Typography variant="mono" sx={{ color: "text.disabled", fontSize: 11 }}>
        →
      </Typography>
      <Tooltip title="Variable holding the result (usable from other cells, in Python or SQL)">
        <InputBase
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^A-Za-z0-9_]/g, ""))}
          error={!validName(value)}
          inputProps={{ "aria-label": "result name", spellCheck: false }}
          sx={{
            fontFamily: "'JetBrains Mono Variable', monospace",
            fontSize: 12,
            color: validName(value) ? "secondary.main" : "error.main",
            width: `${Math.max(4, value.length + 1)}ch`,
          }}
        />
      </Tooltip>
    </Box>
  );
}

export function CellHeader(p: CellHeaderProps) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, pl: 0.5, pr: 1, height: 36 }}>
      {p.dragHandle && <Handle handle={p.dragHandle} />}
      <Tooltip title="Run cell (Shift+Enter)">
        <span>
          <IconButton onClick={p.onRun} disabled={p.disabled} aria-label="run cell" sx={{ color: "success.main" }}>
            <PlayArrowRounded fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Select
        value={p.cell.kind}
        onChange={(e) => p.onKind(e.target.value as CellKind)}
        variant="standard"
        disableUnderline
        sx={{ fontSize: 12, fontWeight: 700, color: "text.secondary", "& .MuiSelect-select": { py: 0 } }}
        inputProps={{ "aria-label": "cell language" }}
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
      <Tooltip title={p.hidden ? "Show code" : "Hide code"}>
        <IconButton onClick={p.onToggleHidden} aria-label={p.hidden ? "show code" : "hide code"} sx={{ color: p.hidden ? "secondary.main" : "text.disabled" }}>
          {p.hidden ? <Code fontSize="small" /> : <CodeOff fontSize="small" />}
        </IconButton>
      </Tooltip>
      {p.hasOutput && (
        <Tooltip title={p.outputHidden ? "Show output" : "Hide output"}>
          <IconButton onClick={p.onToggleOutput} aria-label={p.outputHidden ? "show output" : "hide output"} sx={{ color: p.outputHidden ? "secondary.main" : "text.disabled" }}>
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
