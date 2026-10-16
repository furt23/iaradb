"use client";

import CreateNewFolderOutlined from "@mui/icons-material/CreateNewFolderOutlined";
import DeleteOutline from "@mui/icons-material/DeleteOutlineOutlined";
import DownloadOutlined from "@mui/icons-material/DownloadOutlined";
import DriveFileRenameOutline from "@mui/icons-material/DriveFileRenameOutline";
import EventRepeatOutlined from "@mui/icons-material/EventRepeatOutlined";
import FileCopyOutlined from "@mui/icons-material/FileCopyOutlined";
import LinkOutlined from "@mui/icons-material/LinkOutlined";
import MenuBookOutlined from "@mui/icons-material/MenuBookOutlined";
import NoteAddOutlined from "@mui/icons-material/NoteAddOutlined";
import OpenInNewOutlined from "@mui/icons-material/OpenInNewOutlined";
import PostAddOutlined from "@mui/icons-material/PostAddOutlined";
import TableChartOutlined from "@mui/icons-material/TableChartOutlined";
import VerticalSplitOutlined from "@mui/icons-material/VerticalSplitOutlined";
import Divider from "@mui/material/Divider";
import ListItemIcon from "@mui/material/ListItemIcon";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { AddTableDialog } from "@/features/data/AddTableDialog";
import { NewQueryDialog } from "@/features/queries/NewQueryDialog";
import { useGuard, useNotify } from "@/features/shell/notify";
import { useWorkbench } from "@/features/workbench/WorkbenchProvider";
import { unwrap } from "@/lib/action";
import { duplicateEntry } from "@/server/actions/files";
import type { FileNode } from "@/server/workspace/files";

import { DeleteEntryDialog } from "./DeleteEntryDialog";
import { NewFolderDialog } from "./NewFolderDialog";
import { NewNotebookDialog } from "./NewNotebookDialog";
import { RenameDialog } from "./RenameDialog";

export interface FileMenuTarget {
  node: FileNode;
  /** anchor element, or a pointer position (right-click) */
  anchor: HTMLElement | { x: number; y: number };
  /** the page that shows the file, if any */
  href: string | null;
}

type Dialog = { kind: "rename" | "delete" | "folder" | "notebook" | "query" | "table"; path: string } | null;

function Item({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick(): void; danger?: boolean }) {
  return (
    <MenuItem onClick={onClick} sx={danger ? { color: "error.main" } : undefined}>
      <ListItemIcon sx={danger ? { color: "error.main" } : undefined}>{icon}</ListItemIcon>
      {label}
    </MenuItem>
  );
}

/** Actions on any entry of the file tree: open, rename / move, duplicate, download, delete, new items in folders. */
export function FileMenu({ target, onClose }: { target: FileMenuTarget | null; onClose(): void }) {
  const { t } = useTranslation();
  const { act } = useWorkbench();
  const [dialog, setDialog] = useState<Dialog>(null);
  const guard = useGuard();
  const notify = useNotify();
  const router = useRouter();


  const node = target?.node;
  const anchor = target?.anchor;
  // a pointer position (not `instanceof HTMLElement`: this also renders on the server)
  const point = anchor && "x" in anchor ? anchor : null;
  const run = (fn: (n: FileNode) => void | Promise<void>) => () => {
    if (!node) return;
    onClose();
    void fn(node);
  };
  const open = (kind: NonNullable<Dialog>["kind"]) => run((n) => setDialog({ kind, path: n.path }));
  const duplicate = run((n) =>
    guard(async () => {
      const copy = unwrap(await duplicateEntry(n.path));
      notify(`Created ${copy.path}`, "success");
      router.refresh();
    }),
  );
  const copyPath = run(async (n) => {
    await navigator.clipboard.writeText(n.path);
    notify(`Copied ${n.path}`, "success");
  });
  const download = run((n) => {
    window.location.href = `/api/workspace-file?path=${encodeURIComponent(n.path)}`;
  });

  const items: ReactNode[] = [];
  if (node?.kind === "notebook" || node?.kind === "sql") {
    items.push(
      <Item key="open" icon={<MenuBookOutlined fontSize="small" />} label={t("Open")} onClick={run((n) => act({ type: "open", path: n.path }, true))} />,
      <Item key="side" icon={<VerticalSplitOutlined fontSize="small" />} label={t("Open in a new pane")} onClick={run((n) => act({ type: "openToSide", path: n.path }, true))} />,
      <Item key="job" icon={<EventRepeatOutlined fontSize="small" />} label={t("Schedule as a job…")} onClick={run((n) => router.push(`/jobs?new=${encodeURIComponent(n.path)}`))} />,
      <Divider key="d1" />,
    );
  } else if (node?.kind === "dir") {
    items.push(
      <Item key="nb" icon={<NoteAddOutlined fontSize="small" />} label={t("New notebook here…")} onClick={open("notebook")} />,
      <Item key="query" icon={<PostAddOutlined fontSize="small" />} label={t("New SQL query here…")} onClick={open("query")} />,
      <Item key="folder" icon={<CreateNewFolderOutlined fontSize="small" />} label={t("New folder…")} onClick={open("folder")} />,
      <Item key="table" icon={<TableChartOutlined fontSize="small" />} label={t("Add to the catalog…")} onClick={open("table")} />,
      <Divider key="d1" />,
    );
  } else if (target?.href) {
    const href = target.href;
    items.push(
      <Item key="open" icon={<OpenInNewOutlined fontSize="small" />} label={t("Open")} onClick={run(() => router.push(href))} />,
      <Divider key="d1" />,
    );
  } else if (node?.kind === "data") {
    items.push(<Item key="table" icon={<TableChartOutlined fontSize="small" />} label={t("Add to the catalog…")} onClick={open("table")} />, <Divider key="d1" />);
  }
  items.push(
    <Item key="rename" icon={<DriveFileRenameOutline fontSize="small" />} label={t("Rename / move…")} onClick={open("rename")} />,
    <Item key="dup" icon={<FileCopyOutlined fontSize="small" />} label={t("Duplicate")} onClick={duplicate} />,
  );
  if (node && node.kind !== "dir" && node.kind !== "notebook") {
    items.push(<Item key="dl" icon={<DownloadOutlined fontSize="small" />} label={t("Download")} onClick={download} />);
  }
  items.push(
    <Item key="copy" icon={<LinkOutlined fontSize="small" />} label={t("Copy path")} onClick={copyPath} />,
    <Divider key="d2" />,
    <Item key="delete" icon={<DeleteOutline fontSize="small" />} label={t("Delete…")} onClick={open("delete")} danger />,
  );


  const close = () => setDialog(null);
  return (
    <>
      <Menu
        open={target !== null}
        onClose={onClose}
        anchorEl={anchor && !point ? (anchor as HTMLElement) : null}
        anchorReference={point ? "anchorPosition" : "anchorEl"}
        anchorPosition={point ? { top: point.y, left: point.x } : undefined}
        slotProps={{ list: { dense: true, "aria-label": node ? `actions for ${node.name}` : undefined } }}
      >
        {items}
      </Menu>
      <RenameDialog path={dialog?.kind === "rename" ? dialog.path : null} onClose={close} />
      <DeleteEntryDialog path={dialog?.kind === "delete" ? dialog.path : null} onClose={close} />
      <NewFolderDialog parent={dialog?.kind === "folder" ? dialog.path : null} onClose={close} />
      <NewNotebookDialog open={dialog?.kind === "notebook"} folder={dialog?.path ?? "notebooks"} onClose={close} />
      <NewQueryDialog open={dialog?.kind === "query"} folder={dialog?.path ?? "queries"} onClose={close} />
      <AddTableDialog open={dialog?.kind === "table"} initialPath={dialog?.path} onClose={close} />
    </>
  );
}

