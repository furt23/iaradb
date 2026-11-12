"use client";

import Search from "@mui/icons-material/Search";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import InputAdornment from "@mui/material/InputAdornment";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { PageBody, PageHeader } from "@/features/shell/PageHeader";
import { fold, type OntologyJoin, type OntologyOverview, type OntologyTeamView, type OntologyTerm } from "@/lib/ontology";

import { DraftDialog } from "./DraftDialog";
import { OntologyIcon } from "./OntologyIcon";

const MONO = { fontFamily: "'JetBrains Mono Variable', monospace", fontSize: 12 };

/** Certified, or a draft (dashed, as in the chat). */
function StatusChip({ certified }: { certified: boolean }) {
  const { t } = useTranslation();
  return certified ? (
    <Chip size="small" variant="outlined" color="success" label={t("Certified")} />
  ) : (
    <Chip size="small" variant="outlined" label={t("Draft")} sx={{ borderStyle: "dashed", color: "text.secondary" }} />
  );
}

const matches = (filter: string, ...texts: (string | null)[]) => !filter || texts.some((s) => s && fold(s).includes(filter));

function TermRow({ term }: { term: OntologyTerm }) {
  return (
    <TableRow sx={{ verticalAlign: "top" }}>
      <TableCell sx={{ width: "22%" }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {term.name}
        </Typography>
        {term.synonyms.length > 0 && (
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {term.synonyms.join(", ")}
          </Typography>
        )}
      </TableCell>
      <TableCell sx={{ width: 110 }}>
        <StatusChip certified={term.certified} />
      </TableCell>
      <TableCell>
        <Typography variant="body2">{term.description}</Typography>
        {term.sql && (
          <Box component="pre" sx={{ ...MONO, m: 0, mt: 0.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "text.secondary" }}>
            {term.sql}
          </Box>
        )}
      </TableCell>
      <TableCell sx={{ width: "28%", ...MONO, overflowWrap: "anywhere" }}>
        {term.columns.map((c) => (
          <Box key={c}>{c}</Box>
        ))}
      </TableCell>
    </TableRow>
  );
}

function JoinRow({ join }: { join: OntologyJoin }) {
  return (
    <TableRow sx={{ verticalAlign: "top" }}>
      <TableCell sx={{ ...MONO, overflowWrap: "anywhere" }}>
        {join.left} = {join.right}
      </TableCell>
      <TableCell sx={{ width: 110 }}>
        <StatusChip certified={join.certified} />
      </TableCell>
      <TableCell sx={{ width: "40%" }}>
        <Typography variant="body2">{join.description}</Typography>
      </TableCell>
    </TableRow>
  );
}

/** One team: its name, who reads it, then its terms and joins (those the filter keeps). */
function TeamCard({ team, filter }: { team: OntologyTeamView; filter: string }) {
  const { t } = useTranslation();
  const terms = team.terms.filter((x) => matches(filter, x.name, x.description, x.sql, ...x.synonyms, ...x.columns));
  const joins = team.joins.filter((j) => matches(filter, j.left, j.right, j.description));
  if (filter && !terms.length && !joins.length) return null;
  const drafts = team.terms.filter((x) => !x.certified).length + team.joins.filter((j) => !j.certified).length;
  const readers = team.readers.map((r) => (r === "editors" ? t("All editors") : r)).join(", ");
  return (
    <Paper variant="outlined" sx={{ overflow: "hidden" }}>
      <Box sx={{ px: 2, py: 1.5, display: "flex", alignItems: "baseline", gap: 1.5, flexWrap: "wrap" }}>
        <Typography variant="h3">{team.name}</Typography>
        <Typography variant="caption" sx={{ ...MONO, color: "text.secondary" }}>
          {team.team}.toml
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {t("{{terms}} terms · {{joins}} joins · {{drafts}} drafts", { terms: String(team.terms.length), joins: String(team.joins.length), drafts: String(drafts) })}
        </Typography>
      </Box>
      {(team.description || readers) && (
        <Box sx={{ px: 2, pb: 1.5 }}>
          {team.description && <Typography variant="body2">{team.description}</Typography>}
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {t("Read by: {{who}}", { who: readers || t("team admins only") })}
          </Typography>
        </Box>
      )}
      {terms.length > 0 && (
        <Table size="small" sx={{ tableLayout: "fixed", borderTop: 1, borderColor: "divider" }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: "22%" }}>{t("Term")}</TableCell>
              <TableCell sx={{ width: 110 }}>{t("Status")}</TableCell>
              <TableCell>{t("Description")}</TableCell>
              <TableCell sx={{ width: "28%" }}>{t("Columns")}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {terms.map((x) => (
              <TermRow key={x.name} term={x} />
            ))}
          </TableBody>
        </Table>
      )}
      {joins.length > 0 && (
        <Table size="small" sx={{ tableLayout: "fixed", borderTop: 1, borderColor: "divider" }}>
          <TableHead>
            <TableRow>
              <TableCell>{t("Join between tables")}</TableCell>
              <TableCell sx={{ width: 110 }}>{t("Status")}</TableCell>
              <TableCell sx={{ width: "40%" }}>{t("Description")}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {joins.map((j) => (
              <JoinRow key={`${j.left}=${j.right}`} join={j} />
            ))}
          </TableBody>
        </Table>
      )}
      {!team.terms.length && !team.joins.length && (
        <Typography variant="body2" sx={{ px: 2, pb: 2, color: "text.secondary" }}>
          {t("Nothing here that you can read yet.")}
        </Typography>
      )}
    </Paper>
  );
}

/**
 * The teams' ontologies: what each business term means, as Iara reads it.
 * Those who may (admins, a team's owners) have Iara draft terms from the
 * tables; a draft stays one until someone sets `certified = true` in the file.
 */
export function OntologyView({ overview }: { overview: OntologyOverview }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [filter, setFilter] = useState("");
  const [drafting, setDrafting] = useState(false);
  const { teams, problems, canCreate, where } = overview;
  const mayDraft = canCreate || teams.some((team) => team.canDraft);
  const folded = fold(filter.trim());

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <PageHeader
        title={t("Ontology")}
        subtitle={t("What the teams' business terms mean in the data. Iara reads it to answer.")}
        actions={
          <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
            {teams.length > 0 && (
              <TextField
                size="small"
                placeholder={t("Filter terms")}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                slotProps={{
                  htmlInput: { "aria-label": t("Filter terms") },
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">
                        <Search sx={{ fontSize: 18 }} />
                      </InputAdornment>
                    ),
                  },
                }}
                sx={{ width: 240 }}
              />
            )}
            {mayDraft && (
              <Button variant="contained" startIcon={<OntologyIcon />} onClick={() => setDrafting(true)}>
                {t("Generate draft")}
              </Button>
            )}
          </Stack>
        }
      />
      <PageBody>
        <Stack spacing={2} sx={{ maxWidth: 1200 }}>
          {problems.map((p) => (
            <Alert key={p.team} severity="warning">
              <Box component="span" sx={{ fontWeight: 600 }}>
                {p.team}.toml
              </Box>{" "}
              {t("is not used until it is fixed:")}
              <Box component="pre" sx={{ ...MONO, m: 0, mt: 0.5, whiteSpace: "pre-wrap" }}>
                {p.message}
              </Box>
            </Alert>
          ))}
          {teams.length === 0 && (
            <Box sx={{ py: 6, textAlign: "center", color: "text.secondary" }}>
              <OntologyIcon sx={{ fontSize: 40, color: "text.disabled", mb: 1 }} />
              <Typography variant="h3" sx={{ color: "text.primary", mb: 0.5 }}>
                {t("No ontology yet")}
              </Typography>
              <Typography variant="body2">
                {mayDraft ? t("Have Iara draft a team's terms from its tables, then review them.") : t("A team admin can have Iara draft a team's terms from its tables.")}
              </Typography>
            </Box>
          )}
          {teams.map((team) => (
            <TeamCard key={team.team} team={team} filter={folded} />
          ))}
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {t("One file per team, in {{where}}. Edit a file to fix a term or to set certified = true; changes show within a minute.", { where })}
          </Typography>
        </Stack>
      </PageBody>
      {mayDraft && (
        <DraftDialog
          open={drafting}
          overview={overview}
          onClose={() => setDrafting(false)}
          onDone={() => {
            setDrafting(false);
            router.refresh();
          }}
        />
      )}
    </Box>
  );
}
