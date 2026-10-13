"use client";

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useEffect, useMemo, useState } from "react";

import { useGuard, useNotify } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { gitClearToken, gitSaveRemote, type GitRemoteSettings } from "@/server/actions/git";

import { hasErrors, remoteFormErrors } from "./remoteForm";

/** Connect the team's repository: url, branch and a personal access token (write-only). */
export function RemoteDialog({
  open,
  remote,
  onClose,
  onChanged,
}: {
  open: boolean;
  remote: GitRemoteSettings | null;
  onClose(): void;
  onChanged(next: GitRemoteSettings): void;
}) {
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const guard = useGuard();
  const notify = useNotify();

  useEffect(() => {
    if (open) {
      setUrl(remote?.url ?? "");
      setBranch(remote?.branch || "main");
      setToken("");
    }
  }, [open, remote]);

  const errors = useMemo(() => remoteFormErrors(url, branch), [url, branch]);

  const save = async () => {
    setBusy(true);
    const saved = await guard(async () => unwrap(await gitSaveRemote({ url: url.trim(), branch: branch.trim(), token: token || undefined })));
    setBusy(false);
    if (saved) {
      notify(remote?.url ? "Repository settings saved" : "Repository connected", "success");
      onChanged(saved);
      onClose();
    }
  };

  const removeToken = async () => {
    setBusy(true);
    const next = await guard(async () => unwrap(await gitClearToken()));
    setBusy(false);
    if (next) {
      notify("Token removed", "success");
      onChanged(next);
      onClose();
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{remote?.url ? "Repository settings" : "Connect repository"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField
            label="Repository URL"
            placeholder="https://github.com/your-team/analytics.git"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            error={Boolean(url) && Boolean(errors.url)}
            helperText={url && errors.url ? errors.url : "HTTPS only. Put the token below, not in the URL."}
            autoFocus
          />
          <TextField
            label="Branch"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            error={Boolean(errors.branch)}
            helperText={errors.branch ?? "Pulls and pushes use this branch of origin"}
          />
          <TextField
            label="Personal access token"
            type="password"
            autoComplete="new-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={remote?.hasToken ? "unchanged" : ""}
            helperText="Stored on the server and never shown again. Needs read and write access to the repository."
          />
          {remote?.hasToken && (
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              A token is stored. Leave the field empty to keep it.
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ justifyContent: "space-between", px: 3, pb: 2 }}>
        <Button color="error" onClick={() => void removeToken()} disabled={busy || !remote?.hasToken}>
          Remove token
        </Button>
        <Stack direction="row" spacing={1}>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="contained" onClick={() => void save()} disabled={busy || hasErrors(errors) || !url.trim()}>
            Save
          </Button>
        </Stack>
      </DialogActions>
    </Dialog>
  );
}
