"use client";

import Autocomplete from "@mui/material/Autocomplete";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useGuard } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { attachNotebook } from "@/server/actions/clusters";
import { workspaceTree } from "@/server/actions/workspace";
import type { FileNode } from "@/server/workspace/files";

/** The paths of every notebook in a workspace tree, in tree order. */
function notebookPaths(nodes: FileNode[]): string[] {
  return nodes.flatMap((n) => [...(n.kind === "notebook" ? [n.path] : []), ...notebookPaths(n.children ?? [])]);
}

/** Pick a workspace notebook to attach to a cluster (notebooks already attached are left out). */
export function AttachNotebookDialog({
  open,
  clusterId,
  attached,
  onClose,
  onAttached,
}: {
  open: boolean;
  clusterId: string;
  attached: string[];
  onClose(): void;
  onAttached(): Promise<unknown>;
}) {
  const { t } = useTranslation();
  const guard = useGuard();
  const [options, setOptions] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // read when the dialog opens; a fresh array on every poll must not refetch the tree
  const attachedRef = useRef(attached);
  attachedRef.current = attached;

  useEffect(() => {
    if (!open) return;
    setChoice(null);
    setLoadError(null);
    setOptions(null);
    void (async () => {
      const r = await workspaceTree();
      if (!r.ok) {
        setLoadError(r.error.message);
        return;
      }
      const taken = new Set(attachedRef.current);
      setOptions(notebookPaths(r.data).filter((p) => !taken.has(p)));
    })();
  }, [open]);

  const attach = () =>
    void guard(async () => {
      if (!choice) return;
      setPending(true);
      try {
        unwrap(await attachNotebook(choice, clusterId));
        onClose();
        await onAttached();
      } finally {
        setPending(false);
      }
    });

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t("Attach notebook")}</DialogTitle>
      <DialogContent>
        {loadError && <Typography sx={{ color: "error.main", mb: 2 }}>{loadError}</Typography>}
        <Autocomplete
          options={options ?? []}
          value={choice}
          onChange={(_, v) => setChoice(v)}
          loading={options === null && !loadError}
          noOptionsText={t("No notebook left to attach")}
          renderInput={(params) => (
            <TextField
              {...params}
              label={t("Notebook")}
              margin="dense"
              autoFocus
              helperText={t("Its kernel moves to this cluster the next time it runs.")}
            />
          )}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("Cancel")}</Button>
        <Button variant="contained" onClick={attach} disabled={!choice || pending}>
          {t("Attach")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
