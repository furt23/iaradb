"use client";

import ArrowDownward from "@mui/icons-material/ArrowDownward";
import ArrowUpward from "@mui/icons-material/ArrowUpward";
import DeleteOutline from "@mui/icons-material/DeleteOutlineOutlined";
import MoreVert from "@mui/icons-material/MoreVert";
import UnfoldLess from "@mui/icons-material/UnfoldLess";
import UnfoldMore from "@mui/icons-material/UnfoldMore";
import VisibilityOffOutlined from "@mui/icons-material/VisibilityOffOutlined";
import VisibilityOutlined from "@mui/icons-material/VisibilityOutlined";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import { useState } from "react";

export interface CellMenuProps {
  hidden: boolean;
  hasOutput: boolean;
  outputHidden: boolean;
  onMove(delta: -1 | 1): void;
  onToggleHidden(): void;
  onToggleOutput(): void;
  onDelete(): void;
}

export function CellMenu({ hidden, hasOutput, outputHidden, onMove, onToggleHidden, onToggleOutput, onDelete }: CellMenuProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = (fn: () => void) => () => {
    setAnchor(null);
    fn();
  };
  return (
    <>
      <IconButton aria-label="cell actions" onClick={(e) => setAnchor(e.currentTarget)} sx={{ color: "text.secondary" }}>
        <MoreVert fontSize="small" />
      </IconButton>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
        <MenuItem onClick={close(() => onMove(-1))}>
          <ListItemIcon>
            <ArrowUpward fontSize="small" />
          </ListItemIcon>
          Move up
        </MenuItem>
        <MenuItem onClick={close(() => onMove(1))}>
          <ListItemIcon>
            <ArrowDownward fontSize="small" />
          </ListItemIcon>
          Move down
        </MenuItem>
        <MenuItem onClick={close(onToggleHidden)}>
          <ListItemIcon>{hidden ? <VisibilityOutlined fontSize="small" /> : <VisibilityOffOutlined fontSize="small" />}</ListItemIcon>
          {hidden ? "Show code" : "Hide code"}
        </MenuItem>
        {hasOutput && (
          <MenuItem onClick={close(onToggleOutput)}>
            <ListItemIcon>
              {outputHidden ? <UnfoldMore fontSize="small" /> : <UnfoldLess fontSize="small" />}
            </ListItemIcon>
            {outputHidden ? "Show output" : "Hide output"}
          </MenuItem>
        )}
        <MenuItem onClick={close(onDelete)} sx={{ color: "error.main" }}>
          <ListItemIcon>
            <DeleteOutline fontSize="small" color="error" />
          </ListItemIcon>
          Delete cell
        </MenuItem>
      </Menu>
    </>
  );
}
