"use client";

import Add from "@mui/icons-material/Add";
import MoreVert from "@mui/icons-material/MoreVert";
import SpaceDashboardOutlined from "@mui/icons-material/SpaceDashboardOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";

import { PageBody, PageHeader } from "@/features/shell/PageHeader";
import { useNotify } from "@/features/shell/notify";
import { formatRelative } from "@/lib/format";
import { deleteDashboardAction, listDashboardsAction } from "@/server/actions/dashboards";
import type { DashboardSummary } from "@/lib/dashboards/types";
import type { DashboardProblem } from "@/server/dashboards/store";

import { NewDashboardDialog } from "./NewDashboardDialog";

/** The dashboards of the workspace: open one, start a new one, delete one. */
export function DashboardsList() {
  const { t } = useTranslation();
  const router = useRouter();
  const notify = useNotify();
  const [data, setData] = useState<{ dashboards: DashboardSummary[]; problems: DashboardProblem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; dashboard: DashboardSummary } | null>(null);
  const [deleting, setDeleting] = useState<DashboardSummary | null>(null);

  const reload = useCallback(async () => {
    const r = await listDashboardsAction();
    if (r.ok) {
      setData(r.data);
      setError(null);
    } else setError(r.error.message);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = async (d: DashboardSummary) => {
    const r = await deleteDashboardAction(d.slug);
    if (!r.ok) notify(r.error.message, "error");
    await reload();
  };

  const dashboards = data?.dashboards ?? [];
  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <PageHeader
        title={t("Dashboards")}
        actions={
          <Button variant="contained" color="secondary" startIcon={<Add />} onClick={() => setCreating(true)}>
            {t("New dashboard")}
          </Button>
        }
      />
      <PageBody>
        {error && <Typography sx={{ color: "error.main", mb: 2 }}>{error}</Typography>}
        {data?.problems.map((p) => (
          <Typography key={p.slug} sx={{ color: "warning.main", mb: 1, fontSize: 13 }}>
            {p.slug}: {p.error}
          </Typography>
        ))}
        {data && !dashboards.length && (
          <Box sx={{ textAlign: "center", py: 8, color: "text.secondary" }}>
            <SpaceDashboardOutlined sx={{ fontSize: 40, color: "text.disabled" }} />
            <Typography variant="h4" sx={{ color: "text.primary", mt: 1 }}>
              {t("No dashboards yet")}
            </Typography>
          </Box>
        )}
        {dashboards.length > 0 && (
          <Paper variant="outlined">
            <Table size="small" aria-label={t("Dashboards")}>
              <TableHead>
                <TableRow>
                  <TableCell>{t("Dashboard")}</TableCell>
                  <TableCell>{t("Updated")}</TableCell>
                  <TableCell />
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {dashboards.map((d) => (
                  <TableRow key={d.slug} hover onClick={() => router.push(`/dashboards/${d.slug}`)} sx={{ cursor: "pointer" }}>
                    <TableCell>
                      <Typography
                        component={Link}
                        href={`/dashboards/${d.slug}`}
                        onClick={(e: MouseEvent) => e.stopPropagation()}
                        sx={{ fontWeight: 650, color: "text.primary", textDecoration: "none", "&:hover": { color: "secondary.main" } }}
                      >
                        {d.title}
                      </Typography>
                      {d.description && (
                        <Typography variant="body2" noWrap sx={{ fontSize: 12, color: "text.secondary", maxWidth: 520 }}>
                          {d.description}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontSize: 12, color: "text.secondary" }} title={new Date(d.updatedAt).toLocaleString()}>
                        {formatRelative(d.updatedAt)}
                      </Typography>
                    </TableCell>
                    <TableCell>{d.publishedAt !== null && <Chip size="small" color="success" variant="outlined" label={t("Published")} />}</TableCell>
                    <TableCell align="right">
                      <IconButton
                        aria-label={`${t("Actions for")} ${d.title}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenu({ anchor: e.currentTarget, dashboard: d });
                        }}
                      >
                        <MoreVert fontSize="small" />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        )}
      </PageBody>
      <NewDashboardDialog open={creating} onClose={() => setCreating(false)} />
      <Menu anchorEl={menu?.anchor} open={menu !== null} onClose={() => setMenu(null)}>
        <MenuItem
          sx={{ color: "error.main" }}
          onClick={() => {
            setDeleting(menu!.dashboard);
            setMenu(null);
          }}
        >
          {t("Delete")}
        </MenuItem>
      </Menu>
      <Dialog open={deleting !== null} onClose={() => setDeleting(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{t("Delete {{name}}?", { name: deleting?.title })}</DialogTitle>
        {deleting?.publishedAt && (
          <DialogContent>
            <DialogContentText>{t("Viewers lose access.")}</DialogContentText>
          </DialogContent>
        )}
        <DialogActions>
          <Button onClick={() => setDeleting(null)}>{t("Cancel")}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              const d = deleting!;
              setDeleting(null);
              void remove(d);
            }}
          >
            {t("Delete")}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
