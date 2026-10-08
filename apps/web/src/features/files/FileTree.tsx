"use client";

import ChevronRight from "@mui/icons-material/ChevronRight";
import DataObjectOutlined from "@mui/icons-material/DataObjectOutlined";
import DescriptionOutlined from "@mui/icons-material/DescriptionOutlined";
import ExpandMore from "@mui/icons-material/ExpandMore";
import FolderOutlined from "@mui/icons-material/FolderOutlined";
import InsertDriveFileOutlined from "@mui/icons-material/InsertDriveFileOutlined";
import MenuBookOutlined from "@mui/icons-material/MenuBookOutlined";
import MoreHoriz from "@mui/icons-material/MoreHoriz";
import TableChartOutlined from "@mui/icons-material/TableChartOutlined";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type MouseEvent, type ReactNode } from "react";

import type { FileKind, FileNode } from "@/server/workspace/files";

import { FileMenu, type FileMenuTarget } from "./FileMenu";

const ICONS: Record<FileKind, ReactNode> = {
  dir: <FolderOutlined fontSize="inherit" />,
  notebook: <MenuBookOutlined fontSize="inherit" sx={{ color: "secondary.main" }} />,
  python: <DataObjectOutlined fontSize="inherit" />,
  sql: <DescriptionOutlined fontSize="inherit" />,
  data: <TableChartOutlined fontSize="inherit" sx={{ color: "primary.main" }} />,
  text: <DescriptionOutlined fontSize="inherit" />,
  other: <InsertDriveFileOutlined fontSize="inherit" />,
};

export function hrefOf(node: FileNode): string | null {
  const encoded = node.path.split("/").map(encodeURIComponent).join("/");
  if (node.kind === "notebook") return `/notebooks/${encoded}`;
  if (node.kind === "python" || node.kind === "sql" || node.kind === "text") return `/files/${encoded}`;
  return null;
}

type OnMenu = (node: FileNode, href: string | null, anchor: FileMenuTarget["anchor"]) => void;

/** Reveal the row's "…" on hover, keyboard focus, for the active row and on touch screens. */
function rowSx(active: boolean) {
  return {
    position: "relative",
    "&:hover .row-menu, &:focus-within .row-menu": { opacity: 1 },
    ...(active ? { "& .row-menu": { opacity: 1 } } : {}),
    "@media (hover: none)": { "& .row-menu": { opacity: 1 } },
  } as const;
}

function Row({ node, depth, open, onToggle, active, onMenu }: { node: FileNode; depth: number; open: boolean; onToggle(): void; active: boolean; onMenu: OnMenu }) {
  const href = hrefOf(node);
  const content = (
    <>
      <Box sx={{ width: 16, display: "flex", color: "text.disabled" }}>
        {node.kind === "dir" ? open ? <ExpandMore fontSize="inherit" /> : <ChevronRight fontSize="inherit" /> : null}
      </Box>
      <Box sx={{ display: "flex", fontSize: 16, color: "text.secondary" }}>{ICONS[node.kind]}</Box>
      <Typography noWrap sx={{ fontSize: 13, color: href || node.kind === "dir" ? "text.primary" : "text.secondary" }}>
        {node.name}
      </Typography>
    </>
  );
  const sx = {
    width: "100%",
    justifyContent: "flex-start",
    gap: 0.75,
    pl: 1 + depth * 1.5,
    pr: 3.5,
    py: 0.4,
    borderRadius: 1,
    bgcolor: active ? "action.selected" : "transparent",
    "&:hover": { bgcolor: "action.hover" },
  };
  const menu = (e: MouseEvent<HTMLElement>, anchor: FileMenuTarget["anchor"]) => {
    e.preventDefault();
    e.stopPropagation();
    onMenu(node, href, anchor);
  };
  const main =
    node.kind === "dir" ? (
      <ButtonBase onClick={onToggle} sx={sx} aria-expanded={open}>
        {content}
      </ButtonBase>
    ) : href ? (
      <ButtonBase component={Link} href={href} sx={sx}>
        {content}
      </ButtonBase>
    ) : (
      <Box sx={{ ...sx, display: "flex", alignItems: "center", cursor: "default" }} title="data file">
        {content}
      </Box>
    );
  return (
    <Box sx={rowSx(active)} onContextMenu={(e: MouseEvent<HTMLElement>) => menu(e, { x: e.clientX, y: e.clientY })}>
      {main}
      <IconButton
        className="row-menu"
        aria-label={`actions for ${node.name}`}
        aria-haspopup="menu"
        onClick={(e) => menu(e, e.currentTarget)}
        sx={{ position: "absolute", right: 2, top: "50%", transform: "translateY(-50%)", p: 0.25, opacity: 0, transition: "opacity 100ms" }}
      >
        <MoreHoriz sx={{ fontSize: 16 }} />
      </IconButton>
    </Box>
  );
}

interface NodesProps {
  nodes: FileNode[];
  depth: number;
  expanded: Set<string>;
  toggle(p: string): void;
  current: string;
  onMenu: OnMenu;
}

function Nodes({ nodes, depth, expanded, toggle, current, onMenu }: NodesProps) {
  return (
    <>
      {nodes.map((n) => (
        <Box key={n.path}>
          <Row node={n} depth={depth} open={expanded.has(n.path)} onToggle={() => toggle(n.path)} active={current === hrefOf(n)} onMenu={onMenu} />
          {n.kind === "dir" && expanded.has(n.path) && n.children && (
            <Nodes nodes={n.children} depth={depth + 1} expanded={expanded} toggle={toggle} current={current} onMenu={onMenu} />
          )}
        </Box>
      ))}
    </>
  );
}

function initiallyExpanded(nodes: FileNode[], current: string): Set<string> {
  const open = new Set(nodes.filter((n) => n.kind === "dir" && n.name === "notebooks").map((n) => n.path));
  const parts = decodeURIComponent(current.replace(/^\/(notebooks|files)\//, "")).split("/");
  for (let i = 1; i < parts.length; i++) open.add(parts.slice(0, i).join("/"));
  return open;
}

export function FileTree({ nodes }: { nodes: FileNode[] }) {
  const current = usePathname();
  const [expanded, setExpanded] = useState(() => initiallyExpanded(nodes, current));
  const [menu, setMenu] = useState<FileMenuTarget | null>(null);
  const toggle = (p: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  return (
    <Box role="tree" sx={{ py: 0.5 }}>
      <Nodes nodes={nodes} depth={0} expanded={expanded} toggle={toggle} current={current} onMenu={(node, href, anchor) => setMenu({ node, href, anchor })} />
      <FileMenu target={menu} onClose={() => setMenu(null)} />
    </Box>
  );
}
