"use client";

import Close from "@mui/icons-material/Close";
import IconButton from "@mui/material/IconButton";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

import { useTranslation } from "@/i18n";
import type { AgentTerm } from "@/lib/agents/types";

const MONO = "'JetBrains Mono Variable', monospace";

/** The company's words for the agent, each with the exact meaning it should give them. Terms are added from the section header. */
export function AgentGlossary({ glossary, onGlossary }: { glossary: AgentTerm[]; onGlossary(terms: AgentTerm[]): void }) {
  const { t } = useTranslation();
  const set = (index: number, next: AgentTerm) => onGlossary(glossary.map((g, i) => (i === index ? next : g)));
  const remove = (index: number) => onGlossary(glossary.filter((_, i) => i !== index));

  if (glossary.length === 0) {
    return <Typography sx={{ color: "text.secondary", py: 4, textAlign: "center" }}>{t("No terms yet.")}</Typography>;
  }

  return (
    <Table size="small" aria-label={t("Glossary and business terms")}>
      <TableHead>
        <TableRow>
          <TableCell sx={{ width: "35%" }}>{t("Term")}</TableCell>
          <TableCell>{t("Definition")}</TableCell>
          <TableCell sx={{ width: 48 }} />
        </TableRow>
      </TableHead>
      <TableBody>
        {glossary.map((g, index) => (
          <TableRow
            key={index}
            hover
            sx={{ "& > td": { verticalAlign: "top" }, "&:hover .term-remove, &:focus-within .term-remove": { opacity: 1 } }}
          >
            <TableCell>
              <TextField
                variant="standard"
                fullWidth
                value={g.term}
                error={g.term.trim() === ""}
                placeholder={t("Term")}
                onChange={(e) => set(index, { ...g, term: e.target.value })}
                slotProps={{
                  htmlInput: { "aria-label": t("Term") },
                  input: { disableUnderline: true, sx: { fontFamily: MONO, fontSize: 12.5, fontWeight: 600, color: "primary.main" } },
                }}
              />
            </TableCell>
            <TableCell>
              <TextField
                variant="standard"
                fullWidth
                multiline
                value={g.definition}
                placeholder={t("What the term means in the data")}
                onChange={(e) => set(index, { ...g, definition: e.target.value })}
                slotProps={{
                  htmlInput: { "aria-label": t("Definition") },
                  input: { disableUnderline: true, sx: { fontSize: 13, lineHeight: 1.5 } },
                }}
              />
            </TableCell>
            <TableCell sx={{ width: 48, p: 0.5 }}>
              <IconButton
                className="term-remove"
                size="small"
                aria-label={t("Remove")}
                onClick={() => remove(index)}
                sx={{ opacity: 0, transition: "opacity 0.15s", "@media (hover: none)": { opacity: 1 } }}
              >
                <Close fontSize="inherit" />
              </IconButton>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
