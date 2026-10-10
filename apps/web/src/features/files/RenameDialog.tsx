"use client";

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { useGuard, useNotify } from "@/features/shell/notify";
import { fileHref } from "@/features/workbench/WorkbenchProvider";
import { useWorkbench } from "@/features/workbench/WorkbenchProvider";
import { unwrap } from "@/lib/action";
import { baseName, movedPath, nameError } from "@/lib/paths";
import { renameEntry } from "@/server/actions/files";

/** Rename or move a file or folder: the field holds its whole workspace path. */
export function RenameDialog({ path, onClose }: { path: string | null; onClose(): void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const guard = useGuard();
  const notify = useNotify();
  const router = useRouter();
  const pathname = usePathname();
  const { act } = useWorkbench();

  useEffect(() => {
    if (path === null) return;
    setValue(path);
    // select the name without its extension, as file managers do
    const start = path.length - baseName(path).length;
    const dot = path.lastIndexOf(".");
    const end = dot > start ? dot : path.length;
    requestAnimationFrame(() => input.current?.setSelectionRange(start, end));
  }, [path]);

  const target = value.trim().replace(/^\/+|\/+$/g, "");
  const error = target ? nameError(baseName(target)) : "the path is empty";

  const submit = async () => {
    if (!path || error || busy) return;
    if (target === path) return onClose();
    setBusy(true);
    const moved = await guard(async () => unwrap(await renameEntry(path, target)));
    setBusy(false);
    if (!moved) return;
    onClose();
    act({ type: "rename", from: moved.from, to: moved.to });
    const here = decodeURIComponent(pathname.replace(/^\/(notebooks|queries|files)\//, ""));
    const now = movedPath(here, moved.from, moved.to);
    if (now && pathname.startsWith("/files/")) router.replace(`/files/${now.split("/").map(encodeURIComponent).join("/")}`);
    else if (now && /^\/(notebooks|queries)\//.test(pathname)) router.replace(fileHref(now));
    notify(`Renamed to ${moved.to}`, "success");
    router.refresh();
  };

  return (
    <Dialog open={path !== null} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>Rename</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          inputRef={input}
          label="Path in the workspace"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          error={value !== "" && error !== null}
          helperText={error ?? "Change the folders too to move it"}
          sx={{ mt: 1 }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void submit()} disabled={busy || error !== null}>
          Rename
        </Button>
      </DialogActions>
    </Dialog>
  );
}
