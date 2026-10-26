"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useTranslation } from "react-i18next";

import { useGuard, useNotify } from "@/features/shell/notify";
import { useWorkbench } from "@/features/workbench/WorkbenchProvider";
import { unwrap } from "@/lib/action";
import { isWithin } from "@/lib/paths";
import { deleteEntry, entryInfo } from "@/server/actions/files";
import type { EntryInfo } from "@/server/workspace/fileOps";

function describe(info: EntryInfo | null, t: (key: string, opt?: Record<string, unknown>) => string): string {
  if (!info?.folder) return "";
  const nb = info.notebooks.length;
  const countStr = info.files === 1 ? t("The folder holds {{count}} file", { count: info.files }) : t("The folder holds {{count}} files", { count: info.files });
  return `${countStr}${nb ? `, ${nb} ${t("of them notebooks")}` : ""}.`;
}

/** Confirm, then delete a file or folder: its files, the kernels and open tabs of its notebooks. */
export function DeleteEntryDialog({ path, onClose }: { path: string | null; onClose(): void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<EntryInfo | null>(null);
  const guard = useGuard();
  const notify = useNotify();
  const router = useRouter();
  const pathname = usePathname();
  const { act } = useWorkbench();

  useEffect(() => {
    setInfo(null);
    if (path) void entryInfo(path).then((r) => r.ok && setInfo(r.data));
  }, [path]);

  const confirm = async () => {
    if (!path) return;
    setBusy(true);
    const done = await guard(async () => unwrap(await deleteEntry(path)));
    setBusy(false);
    if (!done) return;
    onClose();
    act({ type: "closeWithin", path: done.path });
    const here = decodeURIComponent(pathname.replace(/^\/files\//, ""));
    if (pathname.startsWith("/files/") && isWithin(here, done.path)) router.push("/");
    notify(`Deleted ${done.path}`, "success");
    router.refresh();
  };

  return (
    <Dialog open={path !== null} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{info?.folder ? t("Delete folder?") : t("Delete?")}</DialogTitle>
      <DialogContent>
        <DialogContentText>
          <Box component="strong" sx={{ overflowWrap: "anywhere" }}>
            {path}
          </Box>{" "}
          {t("will be deleted from the workspace.")} {describe(info, t)} {t("This can't be undone.")}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {t("Cancel")}
        </Button>
        <Button variant="contained" color="error" onClick={() => void confirm()} disabled={busy}>
          {t("Delete")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

