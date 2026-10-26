"use client";

import CloseRounded from "@mui/icons-material/CloseRounded";
import DescriptionOutlined from "@mui/icons-material/DescriptionOutlined";
import GridViewOutlined from "@mui/icons-material/GridViewOutlined";
import MenuBookOutlined from "@mui/icons-material/MenuBookOutlined";
import VerticalSplitOutlined from "@mui/icons-material/VerticalSplitOutlined";
import ViewColumnOutlined from "@mui/icons-material/ViewColumnOutlined";
import ViewStreamOutlined from "@mui/icons-material/ViewStreamOutlined";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Tooltip from "@mui/material/Tooltip";
import { useState, type MouseEvent } from "react";

import { TabBar, TabChip } from "@/features/shell/TabChip";

import { useWorkbench } from "./WorkbenchProvider";
import { MAX_PANES, type Arrangement, type Pane } from "./workbenchState";

function tabLabel(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.py$/, "");
}

function tabIcon(path: string) {
  const sql = path.toLowerCase().endsWith(".sql");
  return (on: boolean) =>
    sql ? (
      <DescriptionOutlined sx={{ fontSize: 14, color: on ? "primary.main" : "text.disabled" }} />
    ) : (
      <MenuBookOutlined sx={{ fontSize: 14, color: on ? "secondary.main" : "text.disabled" }} />
    );
}

const ARRANGEMENTS: { value: Arrangement; label: string; icon: React.ReactNode }[] = [
  { value: "columns", label: "Side by side", icon: <ViewColumnOutlined fontSize="small" /> },
  { value: "rows", label: "Stacked", icon: <ViewStreamOutlined fontSize="small" /> },
  { value: "grid", label: "Grid", icon: <GridViewOutlined fontSize="small" /> },
];

function TabMenu({ anchor, pane, path, onClose }: { anchor: { x: number; y: number } | null; pane: Pane; path: string; onClose(): void }) {
  const { state, act } = useWorkbench();
  const others = state.panes.filter((p) => p.id !== pane.id);
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <Menu open={anchor !== null} onClose={onClose} anchorReference="anchorPosition" anchorPosition={anchor ? { top: anchor.y, left: anchor.x } : undefined}>
      {state.panes.length < MAX_PANES && <MenuItem onClick={run(() => act({ type: "moveTab", path, to: "new" }))}>Move to a new pane</MenuItem>}
      {others.map((p) => (
        <MenuItem key={p.id} onClick={run(() => act({ type: "moveTab", path, to: p.id }))}>
          Move to pane {state.panes.indexOf(p) + 1}
        </MenuItem>
      ))}
      {(others.length > 0 || state.panes.length < MAX_PANES) && <Divider />}
      <MenuItem onClick={run(() => act({ type: "close", pane: pane.id, path }))}>Close</MenuItem>
      <MenuItem disabled={pane.tabs.length < 2} onClick={run(() => act({ type: "closeOthers", pane: pane.id, path }))}>
        Close others
      </MenuItem>
    </Menu>
  );
}

function Tab({ pane, path, active, onMenu }: { pane: Pane; path: string; active: boolean; onMenu(e: MouseEvent, path: string): void }) {
  const { act } = useWorkbench();
  return (
    <TabChip
      label={tabLabel(path)}
      title={path}
      icon={tabIcon(path)}
      active={active}
      onSelect={() => act({ type: "activate", pane: pane.id, path })}
      onClose={() => act({ type: "close", pane: pane.id, path })}
      onMenu={(e) => onMenu(e, path)}
    />
  );
}

function PaneActions({ pane }: { pane: Pane }) {
  const { state, act } = useWorkbench();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const many = state.panes.length > 1;
  return (
    <Box sx={{ display: "flex", alignItems: "center", px: 0.5, gap: 0.25, flexShrink: 0 }}>
      <Tooltip title={state.panes.length < MAX_PANES ? "Split: open another pane" : "Four panes at most"}>
        <span>
          <IconButton aria-label="split pane" disabled={state.panes.length >= MAX_PANES} onClick={() => act({ type: "split", pane: pane.id })}>
            <VerticalSplitOutlined fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      {many && (
        <Tooltip title="Arrange panes">
          <IconButton aria-label="arrange panes" onClick={(e) => setAnchor(e.currentTarget)}>
            {ARRANGEMENTS.find((a) => a.value === state.arrangement)?.icon}
          </IconButton>
        </Tooltip>
      )}
      {many && (
        <Tooltip title="Close pane">
          <IconButton aria-label="close pane" onClick={() => act({ type: "closePane", pane: pane.id })}>
            <CloseRounded fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
        {ARRANGEMENTS.map((a) => (
          <MenuItem
            key={a.value}
            selected={state.arrangement === a.value}
            onClick={() => {
              setAnchor(null);
              act({ type: "arrange", arrangement: a.value });
            }}
          >
            <ListItemIcon>{a.icon}</ListItemIcon>
            {a.label}
          </MenuItem>
        ))}
      </Menu>
    </Box>
  );
}

/** A pane's tabs (click, middle-click to close, right-click for more) and its split / arrange / close actions. */
export function TabStrip({ pane, focused }: { pane: Pane; focused: boolean }) {
  const { state } = useWorkbench();
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  return (
    <TabBar label="notebook tabs" highlight={focused && state.panes.length > 1} actions={<PaneActions pane={pane} />}>
      {pane.tabs.map((path) => (
        <Tab key={path} pane={pane} path={path} active={path === pane.active} onMenu={(e, p) => setMenu({ x: e.clientX, y: e.clientY, path: p })} />
      ))}
      {!pane.tabs.length && (
        <ButtonBase disabled sx={{ px: 1.5, fontSize: 13, color: "text.disabled" }}>
          Empty pane
        </ButtonBase>
      )}
      {menu && <TabMenu anchor={menu} pane={pane} path={menu.path} onClose={() => setMenu(null)} />}
    </TabBar>
  );
}
