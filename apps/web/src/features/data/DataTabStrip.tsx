"use client";

import TableChartOutlined from "@mui/icons-material/TableChartOutlined";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import { useState } from "react";

import { TabBar, TabChip } from "@/features/shell/TabChip";

import { useData } from "./DataProvider";

/** The open tables: click to show, middle-click or × to close, right-click for more. */
export function DataTabStrip() {
  const { tabs, act } = useData();
  const [menu, setMenu] = useState<{ x: number; y: number; name: string } | null>(null);
  const run = (fn: () => void) => () => {
    setMenu(null);
    fn();
  };
  if (!tabs.tabs.length) return null;
  return (
    <TabBar label="table tabs">
      {tabs.tabs.map((name) => (
        <TabChip
          key={name}
          label={name}
          title={name}
          icon={(on) => <TableChartOutlined sx={{ fontSize: 14, color: on ? "primary.main" : "text.disabled" }} />}
          active={name === tabs.active}
          onSelect={() => act({ type: "open", name })}
          onClose={() => act({ type: "close", name })}
          onMenu={(e) => setMenu({ x: e.clientX, y: e.clientY, name })}
        />
      ))}
      <Menu open={menu !== null} onClose={() => setMenu(null)} anchorReference="anchorPosition" anchorPosition={menu ? { top: menu.y, left: menu.x } : undefined}>
        {menu && [
          <MenuItem key="close" onClick={run(() => act({ type: "close", name: menu.name }))}>
            Close
          </MenuItem>,
          <MenuItem key="others" disabled={tabs.tabs.length < 2} onClick={run(() => act({ type: "closeOthers", name: menu.name }))}>
            Close others
          </MenuItem>,
          <MenuItem key="all" onClick={run(() => act({ type: "closeAll" }))}>
            Close all
          </MenuItem>,
        ]}
      </Menu>
    </TabBar>
  );
}
