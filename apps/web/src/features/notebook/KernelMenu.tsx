"use client";

import ArrowDropDown from "@mui/icons-material/ArrowDropDown";
import ClearAll from "@mui/icons-material/ClearAll";
import CodeOutlined from "@mui/icons-material/CodeOutlined";
import PlayCircleOutline from "@mui/icons-material/PlayCircleOutlineOutlined";
import RestartAlt from "@mui/icons-material/RestartAlt";
import StopCircleOutlined from "@mui/icons-material/StopCircleOutlined";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import ListItemIcon from "@mui/material/ListItemIcon";
import Menu from "@mui/material/Menu";
import MenuItem, { type MenuItemProps } from "@mui/material/MenuItem";
import Tooltip from "@mui/material/Tooltip";
import { useState, type ReactNode } from "react";

export interface KernelMenuProps {
  running: boolean;
  onInterrupt(): void;
  onRestart(): void;
  onRestartAndClear(): void;
  onRestartAndRunAll(): void;
  onClearOutputs(): void;
  /** the notebook's setup code (absent: the notebook has none) */
  onShowSetup?(): void;
}

function Item({ icon, children, ...props }: MenuItemProps & { icon: ReactNode }) {
  return (
    <MenuItem {...props}>
      <ListItemIcon>{icon}</ListItemIcon>
      {children}
    </MenuItem>
  );
}

/** The kernel's actions: interrupt, restarts, clearing outputs. */
export function KernelMenu({ running, onInterrupt, onRestart, onRestartAndClear, onRestartAndRunAll, onClearOutputs, onShowSetup }: KernelMenuProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const run = (fn: () => void) => () => {
    setAnchor(null);
    fn();
  };
  return (
    <>
      <Tooltip title="Kernel actions">
        <span>
          <Button
            aria-label="kernel actions"
            aria-haspopup="menu"
            onClick={(e) => setAnchor(e.currentTarget)}
            startIcon={<RestartAlt />}
            endIcon={<ArrowDropDown />}
            sx={{ minWidth: 0, color: "text.secondary" }}
          >
            <span className="tool-label">Kernel</span>
          </Button>
        </span>
      </Tooltip>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
        <Item icon={<StopCircleOutlined fontSize="small" />} disabled={!running} onClick={run(onInterrupt)}>
          Interrupt
        </Item>
        <Divider />
        <Item icon={<RestartAlt fontSize="small" />} onClick={run(onRestart)}>
          Restart
        </Item>
        <Item icon={<RestartAlt fontSize="small" />} onClick={run(onRestartAndClear)}>
          Restart and clear outputs
        </Item>
        <Item icon={<PlayCircleOutline fontSize="small" />} onClick={run(onRestartAndRunAll)}>
          Restart and run all
        </Item>
        <Divider />
        <Item icon={<ClearAll fontSize="small" />} onClick={run(onClearOutputs)}>
          Clear all outputs
        </Item>
        {onShowSetup && <Divider />}
        {onShowSetup && (
          <Item icon={<CodeOutlined fontSize="small" />} onClick={run(onShowSetup)}>
            Show setup code
          </Item>
        )}
      </Menu>
    </>
  );
}
