"use client";

import ArrowDropDown from "@mui/icons-material/ArrowDropDown";
import Check from "@mui/icons-material/Check";
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

import { useTranslation } from "@/i18n";

export interface KernelMenuProps {
  running: boolean;
  onInterrupt(): void;
  onRestart(): void;
  onRestartAndClear(): void;
  onRestartAndRunAll(): void;
  onClearOutputs(): void;
  /** the notebook's setup code (absent: the notebook has none) */
  onShowSetup?(): void;
  /** running a cell also runs the cells that read its values (off: they turn stale) */
  autorun: boolean;
  onAutorun(on: boolean): void;
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
export function KernelMenu({ running, onInterrupt, onRestart, onRestartAndClear, onRestartAndRunAll, onClearOutputs, onShowSetup, autorun, onAutorun }: KernelMenuProps) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const run = (fn: () => void) => () => {
    setAnchor(null);
    fn();
  };
  return (
    <>
      <Tooltip title={t("Kernel actions")}>
        <span>
          <Button
            aria-label={t("kernel actions")}
            aria-haspopup="menu"
            onClick={(e) => setAnchor(e.currentTarget)}
            startIcon={<RestartAlt />}
            endIcon={<ArrowDropDown />}
            sx={{ minWidth: 0, color: "text.secondary" }}
          >
            <span className="tool-label">{t("Kernel")}</span>
          </Button>
        </span>
      </Tooltip>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
        <Item icon={<StopCircleOutlined fontSize="small" />} disabled={!running} onClick={run(onInterrupt)}>
          {t("Interrupt")}
        </Item>
        <Divider />
        <Item icon={<RestartAlt fontSize="small" />} onClick={run(onRestart)}>
          {t("Restart")}
        </Item>
        <Item icon={<RestartAlt fontSize="small" />} onClick={run(onRestartAndClear)}>
          {t("Restart and clear outputs")}
        </Item>
        <Item icon={<PlayCircleOutline fontSize="small" />} onClick={run(onRestartAndRunAll)}>
          {t("Restart and run all")}
        </Item>
        <Divider />
        <Item icon={<ClearAll fontSize="small" />} onClick={run(onClearOutputs)}>
          {t("Clear all outputs")}
        </Item>
        <Divider />
        <Tooltip
          placement="left"
          title={t("Off: the cells that read a cell's values are marked stale when it runs, and run when you run them. On: they run right away.")}
        >
          <Item
            icon={autorun ? <Check fontSize="small" sx={{ color: "primary.main" }} /> : <span />}
            role="menuitemcheckbox"
            aria-checked={autorun}
            onClick={run(() => onAutorun(!autorun))}
          >
            {t("Run dependent cells automatically")}
          </Item>
        </Tooltip>
        {onShowSetup && <Divider />}
        {onShowSetup && (
          <Item icon={<CodeOutlined fontSize="small" />} onClick={run(onShowSetup)}>
            {t("Show setup code")}
          </Item>
        )}
      </Menu>
    </>
  );
}
