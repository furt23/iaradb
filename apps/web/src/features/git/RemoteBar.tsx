"use client";

import CloudDownload from "@mui/icons-material/CloudDownload";
import CloudUpload from "@mui/icons-material/CloudUpload";
import Link from "@mui/icons-material/Link";
import Settings from "@mui/icons-material/Settings";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useGuard, useNotify } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { gitPull, gitPush, type GitRemoteSettings } from "@/server/actions/git";
import type { GitStatus } from "@/server/git/status";
import { displayUrl } from "@/server/git/validate";

import { RemoteDialog } from "./RemoteDialog";

/** The team's remote: connect it, or show it with Pull and Push. */
export function RemoteBar({
  remote,
  status,
  onChanged,
}: {
  remote: GitRemoteSettings | null;
  status: GitStatus | null;
  onChanged(next: GitRemoteSettings): void;
}) {
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState<"pull" | "push" | null>(null);
  const guard = useGuard();
  const notify = useNotify();
  const router = useRouter();

  if (!remote) return null;

  const sync = (kind: "pull" | "push") => {
    setBusy(kind);
    void guard(async () => {
      const summary = unwrap(kind === "pull" ? await gitPull() : await gitPush());
      notify(summary, "success");
      router.refresh();
    }).finally(() => setBusy(null));
  };

  const connected = remote.url !== "";
  const icon = (kind: "pull" | "push", Icon: typeof CloudDownload) => (busy === kind ? <CircularProgress size={16} color="inherit" /> : <Icon />);

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 3, py: 1, minHeight: 52, borderBottom: 1, borderColor: "divider", flexWrap: "wrap" }}>
      {connected ? (
        <>
          <Link fontSize="small" sx={{ color: "text.secondary" }} />
          <Typography noWrap title={displayUrl(remote.url)} sx={{ fontFamily: "'JetBrains Mono Variable', monospace", fontSize: 13, minWidth: 0, maxWidth: 420 }}>
            {displayUrl(remote.url)}
          </Typography>
          <Chip size="small" label={remote.branch} variant="outlined" />
          {status?.upstream && (
            <Chip size="small" variant="outlined" color={status.behind || status.ahead ? "warning" : "default"} label={`${status.ahead} ahead · ${status.behind} behind`} />
          )}
          {!remote.hasToken && <Chip size="small" variant="outlined" label="no token" />}
          <Box sx={{ flex: 1 }} />
          <Button color="inherit" startIcon={<Settings />} onClick={() => setDialog(true)} disabled={busy !== null} sx={{ color: "text.secondary" }}>
            Settings
          </Button>
          <Button variant="outlined" onClick={() => sync("pull")} disabled={busy !== null} startIcon={icon("pull", CloudDownload)}>
            Pull
          </Button>
          <Button variant="outlined" onClick={() => sync("push")} disabled={busy !== null} startIcon={icon("push", CloudUpload)}>
            Push
          </Button>
        </>
      ) : (
        <>
          <Typography sx={{ color: "text.secondary", fontSize: 13 }}>No remote repository connected.</Typography>
          <Box sx={{ flex: 1 }} />
          <Button variant="outlined" startIcon={<Link />} onClick={() => setDialog(true)}>
            Connect repository
          </Button>
        </>
      )}
      <RemoteDialog open={dialog} remote={remote} onClose={() => setDialog(false)} onChanged={onChanged} />
    </Box>
  );
}
