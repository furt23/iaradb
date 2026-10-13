"use client";

import ViewSidebarOutlined from "@mui/icons-material/ViewSidebarOutlined";
import MoreVert from "@mui/icons-material/MoreVert";
import PlayCircleOutline from "@mui/icons-material/PlayCircleOutlineOutlined";
import StopCircleOutlined from "@mui/icons-material/StopCircleOutlined";
import UnfoldLess from "@mui/icons-material/UnfoldLess";
import UnfoldMore from "@mui/icons-material/UnfoldMore";
import Box from "@mui/material/Box";
import Button, { type ButtonProps } from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useState, type ReactNode } from "react";

import { KernelMenu } from "./KernelMenu";
import { RunTimer, type RunTimerProps } from "./RunTimer";

export interface NotebookToolbarProps {
  path: string;
  dirty: boolean;
  running: boolean;
  timer: RunTimerProps;
  onRunAll(): void;
  onInterrupt(): void;
  onRestart(): void;
  onRestartAndClear(): void;
  onRestartAndRunAll(): void;
  onClearOutputs(): void;
  /** opens the setup code (absent: the notebook has none) */
  onShowSetup?(): void;
  /** the side panel: outline and variables */
  onToggleSide(): void;
  sideOpen: boolean;
  onOutputs(hidden: boolean): void;
  /** where the notebook runs (a cluster picker) */
  cluster?: ReactNode;
  /** the File menu, after the save state */
  fileMenu?: ReactNode;
}

/** A toolbar button whose label disappears when the pane is narrow. */
function ToolButton({ label, icon, sx, ...props }: { label: string; icon: ReactNode; sx?: Record<string, unknown> } & Omit<ButtonProps, "startIcon" | "children" | "sx">) {
  return (
    // not on focus: after a click the tooltip would stay over what the button opened
    <Tooltip title={label} disableFocusListener>
      <span>
        <Button startIcon={icon} aria-label={label} sx={{ minWidth: 0, ...sx }} {...props}>
          <span className="tool-label">{label}</span>
        </Button>
      </span>
    </Tooltip>
  );
}

function MoreMenu({ onOutputs }: Pick<NotebookToolbarProps, "onOutputs">) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const run = (fn: () => void) => () => {
    setAnchor(null);
    fn();
  };
  return (
    <>
      <IconButton aria-label="notebook actions" onClick={(e) => setAnchor(e.currentTarget)} sx={{ color: "text.secondary" }}>
        <MoreVert fontSize="small" />
      </IconButton>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
        <MenuItem onClick={run(() => onOutputs(true))}>
          <ListItemIcon>
            <UnfoldLess fontSize="small" />
          </ListItemIcon>
          Hide all outputs
        </MenuItem>
        <MenuItem onClick={run(() => onOutputs(false))}>
          <ListItemIcon>
            <UnfoldMore fontSize="small" />
          </ListItemIcon>
          Show all outputs
        </MenuItem>
      </Menu>
    </>
  );
}

export function NotebookToolbar(p: NotebookToolbarProps) {
  const parts = p.path.split("/");
  return (
    <Box
      sx={{
        containerType: "inline-size",
        display: "flex",
        alignItems: "center",
        gap: 1,
        px: 2,
        height: 48,
        borderBottom: 1,
        borderColor: "divider",
        bgcolor: "background.paper",
        flexShrink: 0,
        "@container (max-width: 820px)": {
          "& .tool-label, & .path-dir": { display: "none" },
          "& .MuiButton-startIcon": { mx: 0 },
        },
        "@container (max-width: 460px)": { "& .save-state": { display: "none" } },
      }}
    >
      <Typography noWrap sx={{ fontSize: 14, minWidth: 0 }}>
        <Box component="span" className="path-dir" sx={{ color: "text.disabled" }}>
          {parts.slice(0, -1).join(" / ")}
          {parts.length > 1 && " / "}
        </Box>
        <Box component="span" sx={{ fontWeight: 650 }}>
          {parts[parts.length - 1]}
        </Box>
      </Typography>
      <Typography variant="body2" className="save-state" sx={{ color: p.dirty ? "warning.main" : "text.disabled", flexShrink: 0 }}>
        {p.dirty ? "unsaved" : "saved"}
      </Typography>
      {p.fileMenu}
      <RunTimer {...p.timer} />
      <Box sx={{ flex: 1 }} />
      {p.cluster}
      <ToolButton label="Run all" icon={<PlayCircleOutline />} onClick={p.onRunAll} disabled={p.running} variant="contained" color="secondary" />
      <ToolButton label="Interrupt" icon={<StopCircleOutlined />} onClick={p.onInterrupt} disabled={!p.running} color="error" />
      <KernelMenu
        running={p.running}
        onInterrupt={p.onInterrupt}
        onRestart={p.onRestart}
        onRestartAndClear={p.onRestartAndClear}
        onRestartAndRunAll={p.onRestartAndRunAll}
        onClearOutputs={p.onClearOutputs}
        onShowSetup={p.onShowSetup}
      />
      <ToolButton label="Outline" icon={<ViewSidebarOutlined />} onClick={p.onToggleSide} sx={{ color: p.sideOpen ? "secondary.main" : "text.secondary" }} />
      <MoreMenu onOutputs={p.onOutputs} />
    </Box>
  );
}
