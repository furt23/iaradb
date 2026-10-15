"use client";

import Add from "@mui/icons-material/Add";
import CreateNewFolderOutlined from "@mui/icons-material/CreateNewFolderOutlined";
import PostAddOutlined from "@mui/icons-material/PostAddOutlined";
import Refresh from "@mui/icons-material/Refresh";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { FileTree } from "@/features/files/FileTree";
import { NewFolderDialog } from "@/features/files/NewFolderDialog";
import { NewNotebookDialog } from "@/features/files/NewNotebookDialog";
import { NewQueryDialog } from "@/features/queries/NewQueryDialog";
import { withoutData } from "@/lib/fileFilter";
import type { FileNode } from "@/server/workspace/files";

import { useTranslation } from "@/i18n";
import { SidePanelHeader } from "./SidePanelHeader";

const SHOW_DATA_KEY = "iara.showDataFiles.v1";

/** Whether the tree shows data files (they belong to the Data section), remembered by the browser. */
function useShowData(): [boolean, (show: boolean) => void] {
  const [show, setShow] = useState(false);
  useEffect(() => {
    try {
      setShow(window.localStorage.getItem(SHOW_DATA_KEY) === "1");
    } catch {
      // storage unavailable
    }
  }, []);
  const set = (value: boolean) => {
    setShow(value);
    try {
      window.localStorage.setItem(SHOW_DATA_KEY, value ? "1" : "0");
    } catch {
      // storage unavailable
    }
  };
  return [show, set];
}

/** The workspace side panel: its name, actions and file tree (notebooks, queries, code; data files on demand). */
export function WorkspacePanel({ name, tree }: { name: string; tree: FileNode[] }) {
  const [creating, setCreating] = useState(false);
  const [folder, setFolder] = useState(false);
  const [query, setQuery] = useState(false);
  const [showData, setShowData] = useShowData();
  const filtered = useMemo(() => withoutData(tree), [tree]);
  const router = useRouter();
  const { t } = useTranslation();
  return (
    <>
      <SidePanelHeader
        overline={t("Workspace")}
        title={name}
        actions={
          <>
            <Tooltip title={t("New notebook")}>
              <IconButton onClick={() => setCreating(true)} aria-label={t("new notebook")}>
                <Add fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title={t("New SQL query")}>
              <IconButton onClick={() => setQuery(true)} aria-label={t("new SQL query")}>
                <PostAddOutlined fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title={t("New folder")}>
              <IconButton onClick={() => setFolder(true)} aria-label={t("new folder")}>
                <CreateNewFolderOutlined fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title={t("Refresh files")}>
              <IconButton onClick={() => router.refresh()} aria-label={t("refresh files")}>
                <Refresh fontSize="small" />
              </IconButton>
            </Tooltip>
          </>
        }
      />
      <Box sx={{ flex: 1, overflow: "auto", px: 0.5 }}>
        <FileTree nodes={showData ? tree : filtered.nodes} />
      </Box>
      {(showData || filtered.hidden > 0) && (
        <ButtonBase
          onClick={() => setShowData(!showData)}
          sx={{ justifyContent: "flex-start", px: 1.5, py: 0.75, borderTop: 1, borderColor: "divider", fontSize: 12, color: "text.secondary", "&:hover": { color: "text.primary" } }}
        >
          {showData
            ? t("Hide data files")
            : t("{{count}} data entries hidden · show", { count: filtered.hidden })}
        </ButtonBase>
      )}
      <NewNotebookDialog open={creating} onClose={() => setCreating(false)} />
      <NewFolderDialog parent={folder ? "" : null} onClose={() => setFolder(false)} />
      <NewQueryDialog open={query} onClose={() => setQuery(false)} />
    </>
  );
}
