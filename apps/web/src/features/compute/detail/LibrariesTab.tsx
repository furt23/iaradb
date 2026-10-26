"use client";

import AddIcon from "@mui/icons-material/Add";
import DeleteOutline from "@mui/icons-material/DeleteOutlineOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useGuard } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { pipSpecMessage } from "../dialog/pipSpecMessage";
import { updateCluster } from "@/server/actions/clusters";
import type { ClusterView, LibraryStatus } from "@/server/compute/types";

/** The chip of one library: its install state on the current machine. */
function StatusChip({ running, status }: { running: boolean; status: LibraryStatus | undefined }) {
  const { t } = useTranslation();
  if (!running) return <Chip size="small" variant="outlined" color="default" label={t("installs at start")} />;
  if (!status) {
    return (
      <Tooltip title={t("Added before this machine started? Restart the cluster.")}>
        <Chip size="small" variant="outlined" color="default" label={t("not installed")} />
      </Tooltip>
    );
  }
  if (status.state === "installed") return <Chip size="small" variant="outlined" color="success" label={t("installed")} />;
  if (status.state === "installing") {
    return (
      <Chip
        size="small"
        variant="outlined"
        color="warning"
        icon={<CircularProgress size={12} color="inherit" sx={{ ml: "8px !important" }} />}
        label={t("installing…")}
      />
    );
  }
  return (
    <Tooltip title={status.error}>
      <Chip size="small" variant="outlined" color="error" label={t("failed")} />
    </Tooltip>
  );
}

/** The pip libraries of a cluster, their install state, and the means to add or remove them. */
export function LibrariesTab({ cluster: c, onChanged }: { cluster: ClusterView; onChanged(): Promise<unknown> }) {
  const { t } = useTranslation();
  const guard = useGuard();
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const libraries = c.libraries ?? [];
  const running = c.state === "running";
  const error = pipSpecMessage(draft, t);

  const save = (next: string[]) =>
    void guard(async () => {
      setPending(true);
      try {
        unwrap(await updateCluster(c.id, { libraries: next }));
        await onChanged();
      } finally {
        setPending(false);
      }
    });

  const add = () => {
    const spec = draft.trim();
    if (!spec || error || libraries.includes(spec)) return;
    setDraft("");
    save([...libraries, spec]);
  };

  return (
    <>
      {c.canManage && (
        <Box sx={{ mb: 1.5 }}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <TextField
              size="small"
              fullWidth
              value={draft}
              error={Boolean(error)}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="pandas==2.2.2"
              slotProps={{ htmlInput: { "aria-label": t("Library") } }}
            />
            <Button
              type="submit"
              variant="outlined"
              startIcon={<AddIcon />}
              disabled={pending || !draft.trim() || Boolean(error)}
              sx={{ flexShrink: 0 }}
            >
              {t("Add")}
            </Button>
          </form>
          {error && (
            <Typography variant="caption" sx={{ display: "block", mt: 0.5, color: "error.main" }}>
              {error}
            </Typography>
          )}
        </Box>
      )}
      {!libraries.length ? (
        <Typography sx={{ color: "text.secondary" }}>{t("No libraries added yet.")}</Typography>
      ) : (
        <Paper variant="outlined">
          <Table size="small" aria-label="libraries">
            <TableHead>
              <TableRow>
                <TableCell>{t("Library")}</TableCell>
                <TableCell>{t("Status")}</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {libraries.map((spec) => (
                <TableRow key={spec}>
                  <TableCell sx={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>{spec}</TableCell>
                  <TableCell>
                    <StatusChip running={running} status={c.libraryStatus?.[spec]} />
                  </TableCell>
                  <TableCell align="right">
                    {c.canManage && (
                      <IconButton
                        size="small"
                        disabled={pending}
                        aria-label={t("remove {{spec}}", { spec })}
                        onClick={() => save(libraries.filter((s) => s !== spec))}
                      >
                        <DeleteOutline fontSize="small" />
                      </IconButton>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}
    </>
  );
}
