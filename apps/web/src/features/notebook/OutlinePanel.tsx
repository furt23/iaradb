"use client";

import ExpandMore from "@mui/icons-material/ExpandMore";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import type { Cell } from "@iara/protocol";
import { useMemo, useState } from "react";

import { outlineOf, type OutlineNode } from "@/lib/outline";

const FLASH_MS = 1200;

/** Scrolls the notebook to a heading (its cell when the heading is not rendered) and flashes the cell. */
function jumpTo(root: ParentNode | null, node: OutlineNode, color: string) {
  const scope = root ?? document;
  const id = CSS.escape(node.cellId);
  const cell = scope.querySelector<HTMLElement>(`[data-cell-id="${id}"]`);
  const heading = scope.querySelector<HTMLElement>(`[data-cell-id="${id}"] [data-heading-index="${node.index}"]`);
  const target = heading ?? cell;
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  cell?.animate([{ boxShadow: `0 0 0 3px ${color}` }, { boxShadow: "0 0 0 3px transparent" }], { duration: FLASH_MS, easing: "ease-out" });
}

const keyOf = (node: OutlineNode) => `${node.cellId}:${node.index}`;

function withToggled(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(keys);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

interface RowProps {
  node: OutlineNode;
  depth: number;
  collapsed: ReadonlySet<string>;
  onToggle(key: string): void;
  onJump(node: OutlineNode): void;
}

function OutlineRow({ node, depth, collapsed, onToggle, onJump }: RowProps) {
  const key = keyOf(node);
  const open = !collapsed.has(key);
  const hasChildren = node.children.length > 0;
  return (
    <>
      <Box sx={{ display: "flex", alignItems: "center", pl: depth * 1.5 + 0.5, pr: 1 }}>
        {hasChildren ? (
          <IconButton size="small" aria-label={open ? "Collapse" : "Expand"} aria-expanded={open} onClick={() => onToggle(key)} sx={{ p: 0.25, mr: 0.25 }}>
            <ExpandMore sx={{ fontSize: 16, transform: open ? "none" : "rotate(-90deg)", transition: "transform 120ms" }} />
          </IconButton>
        ) : (
          <Box sx={{ width: 24, flexShrink: 0 }} />
        )}
        <ButtonBase
          onClick={() => onJump(node)}
          sx={{ flex: 1, minWidth: 0, justifyContent: "flex-start", textAlign: "left", gap: 0.75, px: 0.75, py: 0.5, borderRadius: 1, "&:hover": { bgcolor: "action.hover" } }}
        >
          {node.number !== null && (
            <Typography component="span" variant="mono" sx={{ color: "text.disabled", fontSize: 11.5, flexShrink: 0 }}>
              {node.number}
            </Typography>
          )}
          <Typography component="span" noWrap sx={{ fontSize: 13, fontWeight: depth === 0 ? 650 : 500 }}>
            {node.text}
          </Typography>
        </ButtonBase>
      </Box>
      {open &&
        node.children.map((child) => (
          <OutlineRow key={keyOf(child)} node={child} depth={depth + 1} collapsed={collapsed} onToggle={onToggle} onJump={onJump} />
        ))}
    </>
  );
}

/** The headings of the notebook's markdown cells as a tree; a click scrolls to the heading. */
export function OutlinePanel({ cells, scrollRoot }: { cells: Cell[]; scrollRoot?: HTMLElement | null }) {
  // only markdown cells make headings: typing in a code cell must not rebuild the tree
  const markdown = cells.filter((c) => c.kind === "markdown");
  const markdownKey = markdown.map((c) => `${c.id}\u0000${c.code}`).join("\u0001");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `markdownKey` stands for the markdown cells' content
  const tree = useMemo(() => outlineOf(markdown), [markdownKey]);
  const color = useTheme().palette.primary.main;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  if (!tree.length) {
    return (
      <Typography variant="body2" sx={{ p: 2, color: "text.secondary" }}>
        Add markdown headings to build an outline.
      </Typography>
    );
  }
  return (
    <Box component="nav" aria-label="outline" sx={{ py: 1 }}>
      {tree.map((node) => (
        <OutlineRow
          key={keyOf(node)}
          node={node}
          depth={0}
          collapsed={collapsed}
          onToggle={(key) => setCollapsed((prev) => withToggled(prev, key))}
          onJump={(n) => jumpTo(scrollRoot ?? null, n, color)}
        />
      ))}
    </Box>
  );
}
