"use client";

import DeleteOutlined from "@mui/icons-material/DeleteOutlined";
import Alert from "@mui/material/Alert";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Typography from "@mui/material/Typography";
import { useEffect, useState } from "react";

import { useTranslation } from "@/i18n";
import { formatRelative } from "@/lib/format";
import type { IaraThreadSummary } from "@/lib/iara/protocol";
import { deleteIaraThreadAction, listIaraThreadsAction } from "@/server/actions/iara";

import { SubView } from "./SubView";

/** The file's earlier conversations, newest first: open one or delete it. */
export function HistoryView({
  fileId,
  currentId,
  onOpen,
  onDeleted,
  onBack,
}: {
  fileId: string;
  /** the conversation on screen */
  currentId: string | undefined;
  onOpen(id: string): void;
  onDeleted(id: string): void;
  onBack(): void;
}) {
  const { t } = useTranslation();
  const [threads, setThreads] = useState<IaraThreadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listIaraThreadsAction(fileId).then((r) => {
      if (cancelled) return;
      if (r.ok) setThreads(r.data);
      else setError(r.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  const remove = async (id: string) => {
    const r = await deleteIaraThreadAction(id);
    if (!r.ok) return setError(r.error.message);
    setThreads((all) => all?.filter((x) => x.id !== id) ?? null);
    onDeleted(id);
  };

  return (
    <SubView title={t("History")} onBack={onBack}>
      {error && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}
      {threads?.length === 0 && (
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {t("No earlier conversations.")}
        </Typography>
      )}
      <List dense disablePadding>
        {threads?.map((x) => (
          <ListItem
            key={x.id}
            disablePadding
            secondaryAction={
              <IconButton edge="end" size="small" aria-label={t("Delete")} onClick={() => void remove(x.id)}>
                <DeleteOutlined fontSize="small" />
              </IconButton>
            }
          >
            <ListItemButton selected={x.id === currentId} onClick={() => onOpen(x.id)}>
              <ListItemText primary={x.title || t("New conversation")} secondary={formatRelative(x.updated)} slotProps={{ primary: { noWrap: true } }} />
            </ListItemButton>
          </ListItem>
        ))}
      </List>
    </SubView>
  );
}
