"use client";

import Add from "@mui/icons-material/Add";
import SearchOutlined from "@mui/icons-material/SearchOutlined";
import SmartToyOutlined from "@mui/icons-material/SmartToyOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import InputAdornment from "@mui/material/InputAdornment";
import MenuItem from "@mui/material/MenuItem";
import Skeleton from "@mui/material/Skeleton";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useTranslation } from "@/i18n";
import { useNotify } from "@/features/shell/notify";
import { formatCount } from "@/lib/format";
import type { AgentSummary } from "@/lib/agents/types";
import { deleteAgentAction, listAgentsAction } from "@/server/actions/agents";

import { AgentRow } from "./AgentRow";
import { NewAgentDialog } from "./NewAgentDialog";

interface Listing {
  agents: AgentSummary[];
  problems: { slug: string; error: string }[];
}

type SortKey = "recent" | "name";

/** Lower case, accents dropped: "Produção" matches "producao". */
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function Stat({ label, value }: { label: string; value: string | null }) {
  return (
    <Box sx={{ minWidth: 72 }}>
      <Typography variant="overline" sx={{ color: "text.disabled", fontSize: 10, lineHeight: 1.6, display: "block" }}>
        {label}
      </Typography>
      {value === null ? <Skeleton width={56} height={26} /> : <Typography sx={{ fontWeight: 700, fontSize: 18, lineHeight: 1.4 }}>{value}</Typography>}
    </Box>
  );
}

/** The agents of the workspace: search, open one, start a new one, delete one. */
export function AgentsList() {
  const { t } = useTranslation();
  const notify = useNotify();
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<AgentSummary | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");

  const reload = useCallback(async () => {
    const r = await listAgentsAction();
    if (r.ok) {
      setData(r.data);
      setError(null);
    } else setError(r.error.message);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = async (a: AgentSummary) => {
    const r = await deleteAgentAction(a.slug);
    if (!r.ok) notify(r.error.message, "error");
    await reload();
  };

  const agents = useMemo(() => data?.agents ?? [], [data]);
  const tablesUsed = useMemo(() => new Set(agents.flatMap((a) => a.tableNames)).size, [agents]);
  const visible = useMemo(() => {
    const q = norm(query.trim());
    const list = q
      ? agents.filter((a) => [a.title, a.description, a.slug, ...a.tableNames].some((s) => norm(s).includes(q)))
      : agents;
    return [...list].sort(sort === "name" ? (x, y) => x.title.localeCompare(y.title) : (x, y) => y.updatedAt - x.updatedAt);
  }, [agents, query, sort]);

  const n = visible.length;
  const searching = query.trim() !== "";
  return (
    <Box sx={{ height: "100%", minHeight: 0, overflow: "auto", display: "flex", justifyContent: "center", p: 4 }}>
      <Box sx={{ width: "100%", maxWidth: 1100, display: "flex", flexDirection: "column", gap: 3, pt: { md: 4 } }}>
        <Box sx={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 2 }}>
          <Box>
            <Typography variant="overline" sx={{ color: "secondary.main" }}>
              {t("Agents")}
            </Typography>
            <Typography variant="h2">{t("Agents")}</Typography>
          </Box>
          <Button variant="contained" color="secondary" startIcon={<Add />} onClick={() => setCreating(true)}>
            {t("New agent")}
          </Button>
        </Box>

        {error && <Alert severity="error">{error}</Alert>}
        {data && data.problems.length > 0 && (
          <Alert severity="warning">
            {data.problems.map((p) => (
              <div key={p.slug}>
                {p.slug}: {p.error}
              </div>
            ))}
          </Alert>
        )}

        <Box sx={{ display: "flex", gap: 1.5, alignItems: "center", flexWrap: "wrap" }}>
          <TextField
            size="small"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Search by name, description or table")}
            sx={{ flex: 1, minWidth: 220 }}
            slotProps={{
              input: { startAdornment: <InputAdornment position="start"><SearchOutlined fontSize="small" /></InputAdornment> },
            }}
          />
          <TextField select size="small" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} sx={{ minWidth: 200 }} slotProps={{ select: { inputProps: { "aria-label": t("Sort") } } }}>
            <MenuItem value="recent">{t("Recently changed")}</MenuItem>
            <MenuItem value="name">{t("Name")}</MenuItem>
          </TextField>
        </Box>

        <Box sx={{ display: "flex", gap: 4 }}>
          <Stat label={t("Agents")} value={data ? formatCount(agents.length) : null} />
          <Stat label={t("Tables used")} value={data ? formatCount(tablesUsed) : null} />
        </Box>

        {!data && !error && (
          <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
            <CircularProgress size={22} />
          </Box>
        )}

        {data && agents.length > 0 && (
          <Box>
            <Typography variant="overline" sx={{ color: "text.disabled", display: "block" }}>
              {searching
                ? n === 1 ? t("{{count}} result", { count: n }) : t("{{count}} results", { count: n })
                : n === 1 ? t("{{count}} agent", { count: n }) : t("{{count}} agents", { count: n })}
            </Typography>
            {visible.map((a) => (
              <AgentRow key={a.slug} agent={a} onDelete={() => setDeleting(a)} />
            ))}
            {!visible.length && (
              <Typography variant="body2" sx={{ color: "text.secondary", textAlign: "center", py: 6 }}>
                {t("No agents match “{{query}}”.", { query: query.trim() })}
              </Typography>
            )}
          </Box>
        )}

        {data && !agents.length && (
          <Box sx={{ textAlign: "center", py: 8 }}>
            <SmartToyOutlined sx={{ fontSize: 40, color: "text.disabled" }} />
            <Typography sx={{ color: "text.secondary", mt: 1, mb: 2 }}>{t("No agents yet")}</Typography>
            <Button variant="contained" color="secondary" startIcon={<Add />} onClick={() => setCreating(true)}>
              {t("New agent")}
            </Button>
          </Box>
        )}
      </Box>
      <NewAgentDialog open={creating} onClose={() => setCreating(false)} />
      <Dialog open={deleting !== null} onClose={() => setDeleting(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{t("Delete {{name}}?", { name: deleting?.title })}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t("The agent and its test questions are deleted.")}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleting(null)}>{t("Cancel")}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              const a = deleting!;
              setDeleting(null);
              void remove(a);
            }}
          >
            {t("Delete")}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
