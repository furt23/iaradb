"use client";

import ArrowDropDown from "@mui/icons-material/ArrowDropDown";
import Check from "@mui/icons-material/Check";
import ChevronRight from "@mui/icons-material/ChevronRight";
import DescriptionOutlined from "@mui/icons-material/DescriptionOutlined";
import ExpandMore from "@mui/icons-material/ExpandMore";
import FolderOutlined from "@mui/icons-material/FolderOutlined";
import MenuBookOutlined from "@mui/icons-material/MenuBookOutlined";
import Search from "@mui/icons-material/Search";
import Box from "@mui/material/Box";
import InputAdornment from "@mui/material/InputAdornment";
import InputBase from "@mui/material/InputBase";
import Popover from "@mui/material/Popover";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { fuzzyFilter } from "@/lib/fuzzy";
import { baseName, parentOf } from "@/lib/paths";

import { foldersOf, targetTree, treeRows, type TargetRow } from "./targetTree";

const ICON = { fontSize: 16 } as const;

function RowIcon({ row }: { row: TargetRow }) {
  if (row.folder) return <FolderOutlined sx={{ ...ICON, color: "text.secondary" }} />;
  return row.path.toLowerCase().endsWith(".sql") ? <DescriptionOutlined sx={{ ...ICON, color: "primary.main" }} /> : <MenuBookOutlined sx={{ ...ICON, color: "secondary.main" }} />;
}

/**
 * What a task runs: a field that opens a panel to search the notebooks and
 * query files by name, or browse them by folder.
 */
export function TargetPicker({
  value,
  targets,
  onChange,
  size,
  error,
  helperText,
  autoFocus,
}: {
  value: string;
  targets: string[];
  onChange(target: string): void;
  size: "small" | "medium";
  error: boolean;
  helperText?: string;
  autoFocus?: boolean;
}) {
  const field = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [folders, setFolders] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState(0);
  const tree = useMemo(() => targetTree(targets), [targets]);
  const searching = query.trim() !== "";
  const rows = useMemo<TargetRow[]>(
    () => (searching ? fuzzyFilter(targets, query, (p) => p, 100).map((path) => ({ path, name: baseName(path), depth: 0, folder: false, count: 0 })) : treeRows(tree, folders)),
    [searching, targets, query, tree, folders],
  );

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const show = () => {
    const opened = new Set(value ? foldersOf(value) : []);
    setQuery("");
    setFolders(opened);
    setActive(Math.max(0, treeRows(tree, opened).findIndex((r) => r.path === value)));
    setOpen(true);
  };
  const toggle = (path: string, to = !folders.has(path)) => setFolders((f) => (to ? new Set([...f, path]) : new Set([...f].filter((p) => p !== path && !p.startsWith(`${path}/`)))));
  const choose = (row: TargetRow | undefined) => {
    if (!row) return;
    if (row.folder) return toggle(row.path);
    onChange(row.path);
    setOpen(false);
  };
  const onKey = (e: KeyboardEvent) => {
    const row = rows[active];
    if (e.key === "ArrowDown") setActive((i) => Math.min(i + 1, rows.length - 1));
    else if (e.key === "ArrowUp") setActive((i) => Math.max(i - 1, 0));
    else if (e.key === "Enter") choose(row);
    else if (e.key === "ArrowRight" && row?.folder && !folders.has(row.path)) toggle(row.path, true);
    else if (e.key === "ArrowLeft" && row?.folder && folders.has(row.path)) toggle(row.path, false);
    else if (e.key === "ArrowLeft" && row && !searching && parentOf(row.path)) setActive(rows.findIndex((r) => r.path === parentOf(row.path)));
    else return;
    e.preventDefault();
  };

  return (
    <>
      <TextField
        ref={field}
        size={size}
        label="Runs"
        value={value}
        error={error}
        helperText={helperText}
        autoFocus={autoFocus}
        onClick={show}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
            e.preventDefault();
            show();
          }
        }}
        sx={{ flex: 1, minWidth: 0, "& input": { cursor: "pointer" } }}
        slotProps={{
          input: { readOnly: true, endAdornment: <InputAdornment position="end"><ArrowDropDown sx={{ color: "action.active" }} /></InputAdornment> },
          htmlInput: { role: "combobox", "aria-haspopup": "listbox", "aria-expanded": open },
        }}
      />
      <Popover
        open={open}
        anchorEl={field.current}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        slotProps={{ paper: { sx: { width: Math.max(field.current?.offsetWidth ?? 0, 380), mt: 0.5 } } }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1.5, py: 1, borderBottom: 1, borderColor: "divider" }}>
          <Search sx={{ color: "text.disabled", fontSize: 18 }} />
          <InputBase
            autoFocus
            fullWidth
            placeholder="Search notebooks and queries…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            inputProps={{ "aria-label": "search what the task runs", role: "combobox", "aria-expanded": true, "aria-controls": "target-picker-list" }}
            sx={{ fontSize: 14 }}
          />
        </Box>
        <Box ref={list} id="target-picker-list" role="listbox" aria-label={searching ? "matches" : "folders"} sx={{ maxHeight: 320, overflow: "auto", py: 0.5 }}>
          {rows.map((row, i) => {
            const isOpen = row.folder && folders.has(row.path);
            return (
              <Box
                key={`${row.folder ? "d" : "f"}:${row.path}`}
                role="option"
                aria-selected={row.path === value}
                aria-expanded={row.folder ? isOpen : undefined}
                aria-label={row.folder ? `folder ${row.path}` : row.path}
                data-index={i}
                onMouseMove={() => i !== active && setActive(i)}
                // the search box keeps the focus (and the keys) while folders open and close
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(row)}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 0.75,
                  pl: 1 + row.depth * 2,
                  pr: 1.5,
                  py: 0.5,
                  cursor: "pointer",
                  bgcolor: i === active ? "action.hover" : "transparent",
                }}
              >
                <Box sx={{ width: 16, display: "flex", color: "text.disabled" }}>{row.folder && (isOpen ? <ExpandMore sx={ICON} /> : <ChevronRight sx={ICON} />)}</Box>
                <RowIcon row={row} />
                <Typography noWrap sx={{ fontSize: 13.5, fontWeight: row.path === value ? 650 : 500 }}>
                  {row.name}
                </Typography>
                <Typography noWrap sx={{ fontSize: 12, color: "text.disabled", ml: "auto", pl: 2 }}>
                  {row.folder ? row.count : searching ? parentOf(row.path) || "/" : ""}
                </Typography>
                {row.path === value && <Check sx={{ ...ICON, color: "primary.main" }} />}
              </Box>
            );
          })}
          {!rows.length && (
            <Typography variant="body2" sx={{ color: "text.secondary", px: 2, py: 1.5 }}>
              {searching ? `Nothing matches “${query}”.` : "No notebook or query file in the workspace yet."}
            </Typography>
          )}
        </Box>
      </Popover>
    </>
  );
}
