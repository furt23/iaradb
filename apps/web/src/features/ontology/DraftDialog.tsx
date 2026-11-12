"use client";

import Alert from "@mui/material/Alert";
import Autocomplete from "@mui/material/Autocomplete";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useNotify } from "@/features/shell/notify";
import { scopeOptions, TEAM_ID, type OntologyOverview } from "@/lib/ontology";
import type { DraftEvent, DraftOutcome, DraftProgress } from "@/lib/ontologyDraft";
import { streamEvents } from "@/lib/sse";

const PROGRESS: Record<DraftProgress["step"], string> = {
  tables: "Reading the tables ({{done}} of {{total}})",
  rows: "Reading a few rows ({{done}} of {{total}})",
  terms: "Writing the terms ({{done}} of {{total}})",
};

/** What a finished draft did, in one sentence. */
export function outcomeMessage(o: DraftOutcome, t: (key: string, values?: Record<string, string>) => string): string {
  const parts =
    o.terms + o.joins > 0
      ? [t("{{terms}} terms and {{joins}} joins were written to {{team}}.toml as drafts.", { terms: String(o.terms), joins: String(o.joins), team: o.team })]
      : [t("Nothing new was written to {{team}}.toml.", { team: o.team })];
  if (o.known) parts.push(t("{{count}} were already there.", { count: String(o.known) }));
  if (o.dropped) parts.push(t("{{count}} were left out: the tables do not have their columns.", { count: String(o.dropped) }));
  if (o.sampleError) parts.push(t("No rows were read ({{why}}): the draft comes from the columns alone.", { why: o.sampleError }));
  return parts.join(" ");
}

/**
 * Has Iara draft a team's terms and joins from tables the user picks. An
 * admin may name a new team; an owner picks among theirs. The draft is
 * written at the end of the team's file; nothing that was there changes.
 */
export function DraftDialog({ open, overview, onClose, onDone }: { open: boolean; overview: OntologyOverview; onClose(): void; onDone(): void }) {
  const { t, i18n } = useTranslation();
  const notify = useNotify();
  const teams = useMemo(() => overview.teams.filter((x) => x.canDraft), [overview.teams]);
  const options = useMemo(() => scopeOptions(overview.tables), [overview.tables]);
  const [team, setTeam] = useState("");
  const [name, setName] = useState("");
  const [scope, setScope] = useState<string[]>([]);
  const [samples, setSamples] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<DraftProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  // leaving the page stops the draft
  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    if (!open) return;
    setTeam(teams.length === 1 && !overview.canCreate ? teams[0].team : "");
    setName("");
    setScope([]);
    setSamples(true);
    setError(null);
  }, [open, teams, overview.canCreate]);

  const id = team.trim().toLowerCase();
  const isNew = !!id && !overview.teams.some((x) => x.team === id);
  const valid = TEAM_ID.test(id) && scope.length > 0 && (!isNew || overview.canCreate);

  const submit = async () => {
    if (!valid || busy) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setProgress(null);
    setError(null);
    let outcome: DraftOutcome | null = null;
    let failure: string | null = null;
    try {
      await streamEvents(
        "/api/ontology/draft",
        { team: id, ...(isNew && name.trim() && { name }), scope, samples, language: i18n.language?.startsWith("en") ? "en" : "pt" },
        (e) => {
          const event = e as unknown as DraftEvent;
          if (event.event === "progress") setProgress(event.data);
          else if (event.event === "done") outcome = event.data;
          else if (event.event === "failed") failure = event.data.message;
        },
        controller.signal,
      );
      if (!outcome && !failure) failure = t("The connection was interrupted. Try again.");
    } catch (e) {
      failure = (e as Error).message;
    }
    if (abort.current !== controller) return;
    abort.current = null;
    setBusy(false);
    if (controller.signal.aborted) return;
    const done = outcome as DraftOutcome | null;
    if (!done) return setError(failure);
    notify(outcomeMessage(done, t), done.terms + done.joins > 0 ? "success" : "info");
    onDone();
  };

  /** Cancel: stops a draft being made (the server writes nothing once it sees the request gone), else closes. */
  const cancel = () => {
    if (!busy) return onClose();
    abort.current?.abort();
    abort.current = null;
    setBusy(false);
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t("Generate an ontology draft")}</DialogTitle>
      <DialogContent>
        <Stack
          component="form"
          spacing={2.5}
          sx={{ mt: 1 }}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {error && <Alert severity="error">{error}</Alert>}
          {overview.tablesError && (
            <Alert severity="warning" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {t("The tables could not be listed, so there is nothing to draft from:")} {overview.tablesError}
            </Alert>
          )}
          <Autocomplete
            freeSolo={overview.canCreate}
            options={teams.map((x) => x.team)}
            inputValue={team}
            onInputChange={(_, v) => setTeam(v)}
            disabled={busy}
            renderOption={({ key, ...props }, option) => (
              <li key={key} {...props}>
                {option}
                <Typography component="span" variant="body2" sx={{ color: "text.secondary", ml: 1 }}>
                  {teams.find((x) => x.team === option)?.name}
                </Typography>
              </li>
            )}
            renderInput={(params) => (
              <TextField
                {...params}
                autoFocus
                size="small"
                label={t("Team")}
                error={!!id && !TEAM_ID.test(id)}
                helperText={overview.canCreate ? t("A team's file, or a new id: lowercase letters, digits, - and _ (finance, sales-ops).") : t("The teams whose file names you as an owner.")}
              />
            )}
          />
          {isNew && overview.canCreate && <TextField size="small" label={t("Team name")} placeholder={id} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />}
          <Autocomplete
            multiple
            disableCloseOnSelect
            options={options}
            value={scope}
            onChange={(_, v) => setScope(v)}
            disabled={busy}
            slotProps={{ chip: { size: "small" } }}
            renderInput={(params) => <TextField {...params} size="small" label={t("What to read")} helperText={t("Catalogs, schemas or tables you can read: at most 40 tables in one draft.")} />}
          />
          <FormControlLabel
            control={<Checkbox checked={samples} onChange={(e) => setSamples(e.target.checked)} disabled={busy} />}
            label={t("Read a few rows of each table (needs a running cluster)")}
          />
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {t("The columns, the rows read and the queries people wrote over these tables are sent to the model. What it writes goes to the end of the team's file as drafts: nothing that is there changes, and Iara treats a draft as a hint until someone certifies it.")}
          </Typography>
          {busy && (
            <Stack spacing={0.75}>
              <LinearProgress />
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                {progress ? t(PROGRESS[progress.step], { done: String(progress.done), total: String(progress.total) }) : t("Starting")}
                {" · "}
                {t("This can take a few minutes.")}
              </Typography>
            </Stack>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={cancel}>
          {t("Cancel")}
        </Button>
        <Button variant="contained" onClick={() => void submit()} disabled={!valid || busy}>
          {t("Generate draft")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
