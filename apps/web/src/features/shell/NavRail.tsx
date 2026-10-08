"use client";

import AccountTreeOutlined from "@mui/icons-material/AccountTreeOutlined";
import FolderOutlined from "@mui/icons-material/FolderOutlined";
import HistoryOutlined from "@mui/icons-material/HistoryOutlined";
import Memory from "@mui/icons-material/Memory";
import MenuBookOutlined from "@mui/icons-material/MenuBookOutlined";
import StorageOutlined from "@mui/icons-material/StorageOutlined";
import TerminalOutlined from "@mui/icons-material/TerminalOutlined";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import { LogoMark } from "@workhouse/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { ThemeToggle } from "./ThemeToggle";

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  match: (path: string) => boolean;
}

const ITEMS: NavItem[] = [
  { href: "/", label: "Workspace", icon: <FolderOutlined />, match: (p) => p === "/" || p.startsWith("/files") },
  { href: "/notebooks", label: "Notebooks (open tabs)", icon: <MenuBookOutlined />, match: (p) => p.startsWith("/notebooks") },
  { href: "/catalog", label: "Catalog", icon: <StorageOutlined />, match: (p) => p.startsWith("/catalog") },
  { href: "/sql", label: "SQL editor", icon: <TerminalOutlined />, match: (p) => p.startsWith("/sql") },
  { href: "/history", label: "Query history", icon: <HistoryOutlined />, match: (p) => p.startsWith("/history") },
  { href: "/compute", label: "Compute", icon: <Memory />, match: (p) => p.startsWith("/compute") },
  { href: "/git", label: "Git", icon: <AccountTreeOutlined />, match: (p) => p.startsWith("/git") },
];

export function NavRail() {
  const path = usePathname();
  return (
    <Box
      component="nav"
      sx={{
        width: 56,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 0.5,
        py: 1.5,
        borderRight: 1,
        borderColor: "divider",
        bgcolor: "background.paper",
      }}
    >
      <Box component={Link} href="/" sx={{ mb: 1.5, display: "flex" }} aria-label="Workhouse Studio home">
        <LogoMark size={30} />
      </Box>
      {ITEMS.map((item) => {
        const active = item.match(path);
        return (
          <Tooltip key={item.href} title={item.label} placement="right">
            <IconButton
              component={Link}
              href={item.href}
              aria-label={item.label}
              sx={{
                borderRadius: 2,
                width: 40,
                height: 40,
                color: active ? "secondary.main" : "text.secondary",
                bgcolor: active ? "action.selected" : "transparent",
              }}
            >
              {item.icon}
            </IconButton>
          </Tooltip>
        );
      })}
      <Box sx={{ flex: 1 }} />
      <ThemeToggle />
    </Box>
  );
}
