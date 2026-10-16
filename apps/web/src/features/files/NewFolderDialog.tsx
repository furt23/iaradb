"use client";

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useTranslation } from "@/i18n";
import { useGuard, useNotify } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { joinPath, nameError } from "@/lib/paths";
import { createFolder } from "@/server/actions/files";

/** A new folder inside `parent` ("" = the workspace root). */
export function NewFolderDialog({ parent, onClose }: { parent: string | null; onClose(): void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const guard = useGuard();
  const notify = useNotify();
  const router = useRouter();

  useEffect(() => setName(""), [parent]);
  const error = nameError(name);

  const create = async () => {
    if (parent === null || error || busy) return;
    setBusy(true);
    const made = await guard(async () => unwrap(await createFolder(joinPath(parent, name.trim()))));
    setBusy(false);
    if (!made) return;
    onClose();
    notify(`Created ${made.path}`, "success");
    router.refresh();
  };

  return (
    <Dialog open={parent !== null} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>{parent ? t("New folder in {{parent}}", { parent }) : t("New folder")}</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          label={t("Folder name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void create()}
          error={name !== "" && error !== null}
          helperText={name !== "" ? error : " "}
          sx={{ mt: 1 }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {t("Cancel")}
        </Button>
        <Button variant="contained" onClick={() => void create()} disabled={busy || error !== null}>
          {t("Create")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
