"use client";

import DataObjectOutlined from "@mui/icons-material/DataObjectOutlined";
import DeleteOutline from "@mui/icons-material/DeleteOutlineOutlined";
import MoreVert from "@mui/icons-material/MoreVert";
import PlayCircleOutline from "@mui/icons-material/PlayCircleOutlineOutlined";
import RestartAlt from "@mui/icons-material/RestartAlt";
import StopCircleOutlined from "@mui/icons-material/StopCircleOutlined";
import UnfoldLess from "@mui/icons-material/UnfoldLess";
import UnfoldMore from "@mui/icons-material/UnfoldMore";
import Box from "@mui/material/Box";
import Button, { type ButtonProps } from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useState, type ReactNode } from "react";

import { RunTimer, type RunTimerProps } from "./RunTimer";

export interface NotebookToolbarProps {
  path: string;
  dirty: boolean;
  running: boolean;
  timer: RunTimerProps;
  onRunAll(): void;
  onInterrupt(): void;
  onRestart(): void;
  onToggleVariables(): void;
  onOutputs(hidden: boolean): void;
  onDelete(): void;
  /** where the notebook runs (a cluster picker) */
  cluster?: ReactNode;
}

/** A toolbar button whose label disappears when the pane is narrow. */
function ToolButton({ label, icon, sx, ...props }: { label: string; icon: ReactNode; sx?: Record<string, unknown> } & Omit<ButtonProps, "startIcon" | "children" | "sx">) {
  return (
    <Tooltip title={label}>
      <span>
        <Button startIcon={icon} aria-label={label} sx={{ minWidth: 0, ...sx }} {...props}>
          <span className="tool-label">{label}</span>
        </Button>
      </span>
    </Tooltip>
  );
}

function MoreMenu({ onOutputs, onDelete }: Pick<NotebookToolbarProps, "onOutputs" | "onDelete">) {
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
        <Divider />
        <MenuItem onClick={run(onDelete)} sx={{ color: "error.main" }}>
          <ListItemIcon>
            <DeleteOutline fontSize="small" color="error" />
          </ListItemIcon>
          Delete notebook…
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
      <RunTimer {...p.timer} />
      <Box sx={{ flex: 1 }} />
      {p.cluster}
      <ToolButton label="Run all" icon={<PlayCircleOutline />} onClick={p.onRunAll} disabled={p.running} variant="contained" color="secondary" />
      <ToolButton label="Interrupt" icon={<StopCircleOutlined />} onClick={p.onInterrupt} disabled={!p.running} color="error" />
      <ToolButton label="Restart" icon={<RestartAlt />} onClick={p.onRestart} sx={{ color: "text.secondary" }} />
      <ToolButton label="Variables" icon={<DataObjectOutlined />} onClick={p.onToggleVariables} sx={{ color: "text.secondary" }} />
      <MoreMenu onOutputs={p.onOutputs} onDelete={p.onDelete} />
    </Box>
  );
}
