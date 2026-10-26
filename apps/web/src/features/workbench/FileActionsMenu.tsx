"use client";

import ArrowDropDown from "@mui/icons-material/ArrowDropDown";
import ContentCopyOutlined from "@mui/icons-material/ContentCopyOutlined";
import DeleteOutline from "@mui/icons-material/DeleteOutlineOutlined";
import DownloadOutlined from "@mui/icons-material/DownloadOutlined";
import DriveFileMoveOutlined from "@mui/icons-material/DriveFileMoveOutlined";
import DriveFileRenameOutline from "@mui/icons-material/DriveFileRenameOutline";
import EventRepeatOutlined from "@mui/icons-material/EventRepeatOutlined";
import FileCopyOutlined from "@mui/icons-material/FileCopyOutlined";
import LinkOutlined from "@mui/icons-material/LinkOutlined";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import ListItemIcon from "@mui/material/ListItemIcon";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import type { Cell } from "@iara/protocol";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { DeleteEntryDialog } from "@/features/files/DeleteEntryDialog";
import { MoveDialog } from "@/features/files/MoveDialog";
import { RenameDialog } from "@/features/files/RenameDialog";
import { useGuard, useNotify } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { exportName, fileStem, toIpynb, toMarkdown } from "@/lib/notebookExport";
import { baseName } from "@/lib/paths";
import { duplicateEntry } from "@/server/actions/files";

import { saveText } from "./saveText";
import { fileHref, useWorkbench } from "./WorkbenchProvider";

type Dialog = "rename" | "move" | "delete" | null;

function Item({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick(): void; danger?: boolean }) {
  return (
    <MenuItem onClick={onClick} sx={danger ? { color: "error.main" } : undefined}>
      <ListItemIcon sx={danger ? { color: "error.main" } : undefined}>{icon}</ListItemIcon>
      {label}
    </MenuItem>
  );
}

export interface FileActionsMenuProps {
  /** the notebook or SQL file the header belongs to */
  path: string;
  kind: "notebook" | "sql";
  /** a notebook's cells as the editor holds them (unsaved edits too): for the .ipynb and .md exports */
  cells?: Cell[];
}

/** The "File" menu of a notebook or SQL query header: rename, move, copy, download, schedule, delete. */
export function FileActionsMenu({ path, kind, cells = [] }: FileActionsMenuProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const { act } = useWorkbench();
  const guard = useGuard();
  const notify = useNotify();
  const router = useRouter();

  // the menu closes first; the action runs after
  const pick = (fn: () => unknown) => () => {
    setAnchor(null);
    void fn();
  };
  const open = (which: Dialog) => pick(() => setDialog(which));
  const duplicate = pick(() =>
    guard(async () => {
      const copy = unwrap(await duplicateEntry(path));
      notify(`Created ${copy.path}`, "success");
      act({ type: "open", path: copy.path }, true);
      router.refresh();
    }),
  );
  const copy = (text: () => string, message: string) =>
    pick(() =>
      guard(async () => {
        await navigator.clipboard.writeText(text());
        notify(message, "success");
      }),
    );
  // the file as the server holds it (saved text)
  const saveRaw = pick(() => {
    window.location.href = `/api/workspace-file?path=${encodeURIComponent(path)}`;
  });
  const saveIpynb = pick(() => saveText(exportName(path, ".ipynb"), toIpynb(cells, { name: fileStem(path) }), "application/x-ipynb+json"));
  const saveMarkdown = pick(() => saveText(exportName(path, ".md"), toMarkdown(cells, { title: fileStem(path) }), "text/markdown"));

  const downloads =
    kind === "notebook"
      ? [
          <Item key="py" icon={<DownloadOutlined fontSize="small" />} label="Download .py" onClick={saveRaw} />,
          <Item key="ipynb" icon={<DownloadOutlined fontSize="small" />} label="Download .ipynb" onClick={saveIpynb} />,
          <Item key="md" icon={<DownloadOutlined fontSize="small" />} label="Download .md" onClick={saveMarkdown} />,
        ]
      : [<Item key="sql" icon={<DownloadOutlined fontSize="small" />} label="Download .sql" onClick={saveRaw} />];

  const items: ReactNode[] = [
    <Item key="rename" icon={<DriveFileRenameOutline fontSize="small" />} label="Rename…" onClick={open("rename")} />,
    <Item key="move" icon={<DriveFileMoveOutlined fontSize="small" />} label="Move to…" onClick={open("move")} />,
    <Item key="dup" icon={<FileCopyOutlined fontSize="small" />} label="Duplicate" onClick={duplicate} />,
    <Divider key="d1" />,
    ...downloads,
    <Divider key="d2" />,
    <Item
      key="link"
      icon={<LinkOutlined fontSize="small" />}
      label="Copy link"
      onClick={copy(() => new URL(fileHref(path), window.location.origin).href, "Link copied")}
    />,
    <Item key="path" icon={<ContentCopyOutlined fontSize="small" />} label="Copy path" onClick={copy(() => path, `Copied ${path}`)} />,
    <Divider key="d3" />,
    <Item
      key="job"
      icon={<EventRepeatOutlined fontSize="small" />}
      label="Schedule as a job…"
      onClick={pick(() => router.push(`/jobs?new=${encodeURIComponent(path)}`))}
    />,
    <Divider key="d4" />,
    <Item key="delete" icon={<DeleteOutline fontSize="small" />} label="Delete…" onClick={open("delete")} danger />,
  ];

  return (
    <>
      <Button
        size="small"
        aria-label="file actions"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        endIcon={<ArrowDropDown />}
        onClick={(e) => setAnchor(e.currentTarget)}
        sx={{ color: "text.secondary", flexShrink: 0 }}
      >
        File
      </Button>
      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => setAnchor(null)}
        slotProps={{ list: { dense: true, "aria-label": `actions for ${baseName(path)}` } }}
      >
        {items}
      </Menu>
      <RenameDialog path={dialog === "rename" ? path : null} onClose={() => setDialog(null)} />
      <MoveDialog path={dialog === "move" ? path : null} onClose={() => setDialog(null)} />
      <DeleteEntryDialog path={dialog === "delete" ? path : null} onClose={() => setDialog(null)} />
    </>
  );
}
