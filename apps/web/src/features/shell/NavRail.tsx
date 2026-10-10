"use client";

import AccountTreeOutlined from "@mui/icons-material/AccountTreeOutlined";
import EventRepeatOutlined from "@mui/icons-material/EventRepeatOutlined";
import FolderOutlined from "@mui/icons-material/FolderOutlined";
import HistoryOutlined from "@mui/icons-material/HistoryOutlined";
import Memory from "@mui/icons-material/Memory";
import Search from "@mui/icons-material/Search";
import StorageOutlined from "@mui/icons-material/StorageOutlined";
import TerminalOutlined from "@mui/icons-material/TerminalOutlined";
import Box from "@mui/material/Box";
import useMediaQuery from "@mui/material/useMediaQuery";
import { usePathname } from "next/navigation";
import { Fragment, useState, type ReactNode } from "react";

import { NavItem } from "./NavItem";
import { RailBrand } from "./RailBrand";
import { RailToggle } from "./RailToggle";
import { SECTIONS, sectionOf, type SectionId } from "./sections";
import { useShell } from "./ShellProvider";
import { ThemeToggle } from "./ThemeToggle";

const ICONS: Record<SectionId, ReactNode> = {
  workspace: <FolderOutlined />,
  data: <StorageOutlined />,
  sql: <TerminalOutlined />,
  history: <HistoryOutlined />,
  jobs: <EventRepeatOutlined />,
  compute: <Memory />,
  git: <AccountTreeOutlined />,
};

const WIDTH = { expanded: 200, collapsed: 56 };
/** below this width the rail always shows icons only (the stored choice is kept) */
const NARROW = "(max-width:899.95px)";
/** a small gap follows these sections, to group them */
const GROUP_ENDS: SectionId[] = ["sql", "compute"];

/**
 * The navigation rail: quick open, the sections and the theme. Expanded it
 * shows their names; collapsed, icons with tooltips. Clicking the current
 * section shows or hides its side panel (Ctrl/Cmd+B).
 */
export function NavRail() {
  const current = sectionOf(usePathname());
  const { panelOpen, togglePanel, setQuickOpen, railExpanded, toggleRail } = useShell();
  const narrow = useMediaQuery(NARROW);
  const expanded = railExpanded && !narrow;
  // the width animates after the user's own toggle, not when the stored choice loads
  const [animated, setAnimated] = useState(false);

  return (
    <Box
      component="nav"
      sx={{
        width: expanded ? WIDTH.expanded : WIDTH.collapsed,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        gap: 0.5,
        px: 1,
        py: 1.5,
        overflow: "hidden",
        borderRight: 1,
        borderColor: "divider",
        bgcolor: "background.paper",
        transition: animated ? "width 150ms ease" : "none",
      }}
    >
      <RailBrand expanded={expanded} />
      <NavItem
        icon={<Search />}
        label="Search"
        name="open by name"
        tooltip="Open anything by name (Ctrl+K)"
        hint="Ctrl K"
        expanded={expanded}
        onClick={() => setQuickOpen(true)}
      />
      {SECTIONS.map((s) => {
        const active = s.id === current;
        const toggles = active && s.panel !== null;
        return (
          <Fragment key={s.id}>
            <NavItem
              icon={ICONS[s.id]}
              label={s.label}
              href={s.href}
              active={active}
              expanded={expanded}
              tooltip={toggles ? `${s.label} · ${panelOpen ? "hide" : "show"} the side panel (Ctrl+B)` : s.label}
              onClick={(e) => {
                if (!toggles) {
                  togglePanel(true);
                  return;
                }
                e.preventDefault();
                togglePanel();
              }}
            />
            {GROUP_ENDS.includes(s.id) && <Box sx={{ height: 4, flexShrink: 0 }} />}
          </Fragment>
        );
      })}
      <Box sx={{ flex: 1 }} />
      <Box sx={{ display: "flex", flexDirection: expanded ? "row" : "column", alignItems: "center", justifyContent: "space-between", gap: 0.5 }}>
        <ThemeToggle />
        {!narrow && (
          <RailToggle
            expanded={expanded}
            onToggle={() => {
              setAnimated(true);
              toggleRail();
            }}
          />
        )}
      </Box>
    </Box>
  );
}
