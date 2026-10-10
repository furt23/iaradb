"use client";

import DescriptionOutlined from "@mui/icons-material/DescriptionOutlined";
import EastRounded from "@mui/icons-material/EastRounded";
import MenuBookOutlined from "@mui/icons-material/MenuBookOutlined";
import Search from "@mui/icons-material/Search";
import TableChartOutlined from "@mui/icons-material/TableChartOutlined";
import Box from "@mui/material/Box";
import Dialog from "@mui/material/Dialog";
import InputBase from "@mui/material/InputBase";
import Typography from "@mui/material/Typography";
import type { TableRef } from "@workhouse/protocol";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { tableHref } from "@/features/data/links";
import { useWorkbench } from "@/features/workbench/WorkbenchProvider";
import { fuzzyFilter } from "@/lib/fuzzy";
import { baseName, parentOf } from "@/lib/paths";

import { SECTIONS } from "./sections";
import { useShell } from "./ShellProvider";

interface Item {
  key: string;
  /** what the query is matched against */
  text: string;
  label: string;
  detail: string;
  icon: ReactNode;
  open(): void;
}

const ICON = { fontSize: 16 } as const;

/** Open a notebook, query, table or page by typing part of its name (Ctrl/Cmd+K). */
export function QuickOpen({ files, tables }: { files: string[]; tables: TableRef[] }) {
  const { quickOpen, setQuickOpen } = useShell();
  const { recent, act } = useWorkbench();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const items = useMemo<Item[]>(() => {
    const known = new Set(files);
    // recently opened files first
    const ordered = [...recent.filter((p) => known.has(p)), ...files.filter((p) => !recent.includes(p))];
    const fileItems = ordered.map((path): Item => {
      const sql = path.toLowerCase().endsWith(".sql");
      return {
        key: `file:${path}`,
        text: path,
        label: baseName(path),
        detail: parentOf(path) || "/",
        icon: sql ? <DescriptionOutlined sx={{ ...ICON, color: "primary.main" }} /> : <MenuBookOutlined sx={{ ...ICON, color: "secondary.main" }} />,
        open: () => act({ type: "open", path }, true),
      };
    });
    const tableItems = tables.map(
      (t): Item => ({
        key: `table:${t.name}`,
        text: t.name,
        label: t.name,
        detail: `table · ${t.path}`,
        icon: <TableChartOutlined sx={{ ...ICON, color: "primary.main" }} />,
        open: () => router.push(tableHref(t.name)),
      }),
    );
    const pages = SECTIONS.map(
      (s): Item => ({
        key: `page:${s.id}`,
        text: s.label,
        label: s.label,
        detail: "page",
        icon: <EastRounded sx={{ ...ICON, color: "text.secondary" }} />,
        open: () => router.push(s.href),
      }),
    );
    return [...fileItems, ...tableItems, ...pages];
  }, [files, tables, recent, act, router]);

  const shown = useMemo(() => fuzzyFilter(items, query, (i) => i.text, 60), [items, query]);

  useEffect(() => {
    if (quickOpen) {
      setQuery("");
      setSelected(0);
    }
  }, [quickOpen]);
  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const close = () => setQuickOpen(false);
  const choose = (item: Item | undefined) => {
    if (!item) return;
    close();
    item.open();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") setSelected((i) => Math.min(i + 1, shown.length - 1));
    else if (e.key === "ArrowUp") setSelected((i) => Math.max(i - 1, 0));
    else if (e.key === "Enter") choose(shown[selected]);
    else return;
    e.preventDefault();
  };

  return (
    <Dialog
      open={quickOpen}
      onClose={close}
      fullWidth
      maxWidth="sm"
      slotProps={{ paper: { sx: { alignSelf: "flex-start", mt: "12vh" } } }}
      aria-label="quick open"
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, py: 1.25, borderBottom: 1, borderColor: "divider" }}>
        <Search sx={{ color: "text.disabled" }} />
        <InputBase
          autoFocus
          fullWidth
          placeholder="Open a notebook, query, table or page…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          inputProps={{ "aria-label": "name to open", role: "combobox", "aria-expanded": true, "aria-controls": "quick-open-list" }}
          sx={{ fontSize: 15 }}
        />
      </Box>
      <Box ref={list} id="quick-open-list" role="listbox" aria-label="matches" sx={{ maxHeight: "50vh", overflow: "auto", py: 0.5 }}>
        {shown.map((item, i) => (
          <Box
            key={item.key}
            role="option"
            aria-selected={i === selected}
            data-index={i}
            onMouseMove={() => i !== selected && setSelected(i)}
            onClick={() => choose(item)}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1.25,
              px: 2,
              py: 0.75,
              cursor: "pointer",
              bgcolor: i === selected ? "action.selected" : "transparent",
            }}
          >
            {item.icon}
            <Typography noWrap sx={{ fontSize: 13.5, fontWeight: 550 }}>
              {item.label}
            </Typography>
            <Typography noWrap sx={{ fontSize: 12, color: "text.disabled", ml: "auto", pl: 2 }}>
              {item.detail}
            </Typography>
          </Box>
        ))}
        {!shown.length && (
          <Typography variant="body2" sx={{ color: "text.secondary", px: 2, py: 1.5 }}>
            Nothing matches “{query}”.
          </Typography>
        )}
      </Box>
    </Dialog>
  );
}
