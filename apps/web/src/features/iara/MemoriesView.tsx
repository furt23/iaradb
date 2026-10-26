"use client";

import Check from "@mui/icons-material/Check";
import Close from "@mui/icons-material/Close";
import DeleteOutlined from "@mui/icons-material/DeleteOutlined";
import EditOutlined from "@mui/icons-material/EditOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useEffect, useState } from "react";

import { useTranslation } from "@/i18n";
import type { IaraMemory } from "@/lib/iara/protocol";
import { addIaraMemoryAction, deleteIaraMemoryAction, listIaraMemoriesAction, updateIaraMemoryAction } from "@/server/actions/iara";
import type { ActionResult } from "@/server/result";

import { SubView } from "./SubView";

/** What Iara remembers about the user: add, edit (inline) and delete. */
export function MemoriesView({ onBack }: { onBack(): void }) {
  const { t } = useTranslation();
  const [memories, setMemories] = useState<IaraMemory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listIaraMemoriesAction().then((r) => {
      if (cancelled) return;
      if (r.ok) setMemories(r.data);
      else setError(r.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Runs an action and, if it worked, applies its result to the list; otherwise shows why it did not. */
  const act = async <T,>(result: Promise<ActionResult<T>>, onOk: (data: T) => void) => {
    const r = await result;
    if (r.ok) {
      setError(null);
      onOk(r.data);
    } else setError(r.error.message);
  };

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    void act(addIaraMemoryAction(text), (m) => {
      setMemories((all) => [...(all ?? []), m]);
      setDraft("");
    });
  };

  const save = () => {
    const edit = editing;
    if (!edit || !edit.text.trim()) return;
    void act(updateIaraMemoryAction(edit.id, edit.text.trim()), (m) => {
      setMemories((all) => all?.map((x) => (x.id === m.id ? m : x)) ?? null);
      setEditing(null);
    });
  };

  const remove = (id: string) => void act(deleteIaraMemoryAction(id), () => setMemories((all) => all?.filter((x) => x.id !== id) ?? null));

  return (
    <SubView title={t("Memories")} onBack={onBack}>
      <Typography variant="body2" sx={{ color: "text.secondary", mb: 1.5 }}>
        {t("Iara remembers these about you. They are only yours.")}
      </Typography>
      {error && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}
      <Box sx={{ display: "flex", gap: 1, mb: 1.5 }}>
        <TextField
          fullWidth
          size="small"
          label={t("Add a memory")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) add();
          }}
        />
        <Button disabled={draft.trim() === ""} onClick={add}>
          {t("Add")}
        </Button>
      </Box>
      {memories?.length === 0 && (
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {t("Nothing remembered yet.")}
        </Typography>
      )}
      {memories?.map((m) => (
        <Box key={m.id} sx={{ display: "flex", alignItems: "center", gap: 0.5, py: 0.75, borderBottom: 1, borderColor: "divider" }}>
          {editing?.id === m.id ? (
            <>
              <TextField
                autoFocus
                fullWidth
                multiline
                size="small"
                value={editing.text}
                onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setEditing(null);
                }}
              />
              <IconButton size="small" aria-label={t("Save")} onClick={save} disabled={editing.text.trim() === ""}>
                <Check fontSize="small" />
              </IconButton>
              <IconButton size="small" aria-label={t("Cancel")} onClick={() => setEditing(null)}>
                <Close fontSize="small" />
              </IconButton>
            </>
          ) : (
            <>
              <Typography variant="body2" sx={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                {m.text}
              </Typography>
              <IconButton size="small" aria-label={t("Edit")} onClick={() => setEditing({ id: m.id, text: m.text })}>
                <EditOutlined fontSize="small" />
              </IconButton>
              <IconButton size="small" aria-label={t("Delete")} onClick={() => remove(m.id)}>
                <DeleteOutlined fontSize="small" />
              </IconButton>
            </>
          )}
        </Box>
      ))}
    </SubView>
  );
}
