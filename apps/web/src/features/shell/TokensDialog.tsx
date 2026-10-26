"use client";

import ContentCopyOutlined from "@mui/icons-material/ContentCopyOutlined";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { LocalTime } from "@/features/shell/LocalTime";
import { useNotify } from "@/features/shell/notify";
import { createTokenAction, listTokensAction, revokeTokenAction } from "@/server/actions/tokens";
import type { TokenSummary } from "@/server/auth/tokens";

/** A read-only monospace value with a copy button. */
function CopyField({ label, value, onCopy }: { label: string; value: string; onCopy(text: string): void }) {
  const { t } = useTranslation();
  return (
    <TextField
      label={label}
      value={value}
      multiline
      fullWidth
      slotProps={{
        input: {
          readOnly: true,
          sx: { fontFamily: "monospace", fontSize: 13 },
          endAdornment: (
            <InputAdornment position="end">
              <Tooltip title={t("Copy")}>
                <IconButton edge="end" aria-label={t("Copy")} onClick={() => onCopy(value)}>
                  <ContentCopyOutlined fontSize="small" />
                </IconButton>
              </Tooltip>
            </InputAdornment>
          ),
        },
      }}
    />
  );
}

/** Personal access tokens for MCP clients (Claude Code, Cursor ...): create, list, revoke. */
export function TokensDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const [tokens, setTokens] = useState<TokenSummary[] | null>(null);
  const [name, setName] = useState("");
  // the new token's secret, shown once; the origin is read on create (the page is server-rendered first)
  const [made, setMade] = useState<{ token: string; origin: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await listTokensAction();
    if (r.ok) setTokens(r.data);
    else setError(r.error.message);
  }, []);

  useEffect(() => {
    if (!open) return;
    setName("");
    setMade(null);
    setError(null);
    void refresh();
  }, [open, refresh]);

  const create = async () => {
    const label = name.trim();
    if (!label || busy) return;
    setBusy(true);
    setError(null);
    const r = await createTokenAction(label);
    setBusy(false);
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    setMade({ token: r.data.token, origin: window.location.origin });
    setName("");
    void refresh();
  };

  const revoke = async (id: string) => {
    setBusy(true);
    setError(null);
    const r = await revokeTokenAction(id);
    setBusy(false);
    if (r.ok) void refresh();
    else setError(r.error.message);
  };

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    notify(t("Copied"), "success");
  };

  const url = made ? `${made.origin}/api/mcp` : "";
  const command = made ? `claude mcp add --transport http iara ${url} --header "Authorization: Bearer ${made.token}"` : "";

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t("Connect an AI client (MCP)")}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <Stack
            component="form"
            direction="row"
            spacing={1}
            sx={{ alignItems: "flex-start" }}
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <TextField
              size="small"
              fullWidth
              label={t("Token name")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              slotProps={{ htmlInput: { maxLength: 60 } }}
            />
            <Button type="submit" variant="contained" disabled={busy || !name.trim()} sx={{ flexShrink: 0 }}>
              {t("Create token")}
            </Button>
          </Stack>
          {made && (
            <Stack spacing={1.5}>
              <Alert severity="warning">{t("Copy it now: it is not shown again.")}</Alert>
              <CopyField label={t("Access token")} value={made.token} onCopy={copy} />
              <CopyField label={t("Add to Claude Code")} value={command} onCopy={copy} />
              <Typography variant="body2" color="text.secondary">
                {t("Cursor and other MCP clients: URL {{url}}, header Authorization: Bearer {{token}}.", { url, token: made.token })}
              </Typography>
            </Stack>
          )}
          <Stack spacing={1}>
            <Typography variant="subtitle2">{t("Your tokens")}</Typography>
            {tokens && tokens.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                {t("No tokens yet.")}
              </Typography>
            )}
            {tokens?.map((k) => (
              <Stack key={k.id} direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <Stack sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" noWrap>
                    {k.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t("Created")} <LocalTime ms={k.createdAt} /> · {t("Last used")}: {k.lastUsedAt ? <LocalTime ms={k.lastUsedAt} /> : t("never")}
                  </Typography>
                </Stack>
                <Button size="small" color="error" disabled={busy} onClick={() => void revoke(k.id)}>
                  {t("Revoke")}
                </Button>
              </Stack>
            ))}
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("Close")}</Button>
      </DialogActions>
    </Dialog>
  );
}
