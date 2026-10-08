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

import { useGuard, useNotify } from "@/features/shell/notify";
import { useWorkbench } from "@/features/workbench/WorkbenchProvider";
import { unwrap } from "@/lib/action";
import { isWithin } from "@/lib/paths";
import { deleteEntry, entryInfo } from "@/server/actions/files";
import type { EntryInfo } from "@/server/workspace/fileOps";

function describe(info: EntryInfo | null): string {
  if (!info) return "";
  if (!info.folder) return info.notebooks.length ? "This notebook's kernel will be stopped." : "";
  const nb = info.notebooks.length;
  return `The folder holds ${info.files} file${info.files === 1 ? "" : "s"}${nb ? `, ${nb} of them notebooks (their kernels will be stopped)` : ""}.`;
}

/** Confirm, then delete a file or folder: its files, the kernels and open tabs of its notebooks. */
export function DeleteEntryDialog({ path, onClose }: { path: string | null; onClose(): void }) {
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
      <DialogTitle>{info?.folder ? "Delete folder?" : "Delete?"}</DialogTitle>
      <DialogContent>
        <DialogContentText>
          <Box component="strong" sx={{ overflowWrap: "anywhere" }}>
            {path}
          </Box>{" "}
          will be deleted from the workspace. {describe(info)} This cannot be undone here (files in Git can be restored from there).
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" color="error" onClick={() => void confirm()} disabled={busy}>
          Delete
        </Button>
      </DialogActions>
    </Dialog>
  );
}
