"use client";

import ArrowForwardOutlined from "@mui/icons-material/ArrowForwardOutlined";
import DeleteOutline from "@mui/icons-material/DeleteOutlineOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { ColumnInfo } from "@iara/protocol";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Dataset } from "@/lib/dashboards/types";
import type { ColumnRef } from "@/lib/model/types";

import { removeRelationship } from "./modelEdits";
import { suggestRelationships } from "./relationships";
import { columnsIn, useReadColumns, type FoundColumns } from "./useDatasetColumns";
import { useModel, useModelSource } from "./useModel";
import { useRelate } from "./useRelate";

const HEADING = { fontSize: 12, fontWeight: 650, color: "text.secondary" };
const MONO = { fontFamily: "var(--font-mono, monospace)", fontSize: 12, overflowWrap: "anywhere" } as const;

const refText = (c: ColumnRef) => `${c.dataset}.${c.column}`;

function Form({ slug, focus, datasets, found, load, onClose }: { slug: string; focus: string[]; datasets: Dataset[]; found: FoundColumns; load(name: string): Promise<ColumnInfo[]>; onClose(): void }) {
  const { t } = useTranslation();
  const model = useModel();
  const { source, setSource } = useModelSource();
  const [left, setLeft] = useState<ColumnRef>({ dataset: focus[0] ?? "", column: "" });
  const [right, setRight] = useState<ColumnRef>({ dataset: focus[1] ?? "", column: "" });
  const { connect: relate, busy } = useRelate(slug, datasets, found);
  const [problem, setProblem] = useState<string | null>(null);
  useReadColumns(datasets, found, load);

  const read = useMemo(() => Object.fromEntries(datasets.map((d) => [d.name, columnsIn(found, d.name)])), [datasets, found]);
  const suggestions = useMemo(() => suggestRelationships(read, model.relationships, focus), [read, model.relationships, focus]);
  const made = model.relationships.filter((r) => r.cast !== "date");

  const connect = async (a: ColumnRef, b: ColumnRef) => {
    setProblem(null);
    const why = await relate(a, b);
    if (why) return setProblem(why);
    setLeft({ dataset: "", column: "" });
    setRight({ dataset: "", column: "" });
  };

  const sidePicker = (side: ColumnRef, set: (c: ColumnRef) => void, label: string) => (
    <Stack spacing={1} sx={{ flex: 1, minWidth: 0 }}>
      <TextField select size="small" fullWidth label={label} value={side.dataset} onChange={(e) => set({ dataset: e.target.value, column: "" })} slotProps={{ inputLabel: { shrink: true } }}>
        {datasets.map((d) => (
          <MenuItem key={d.name} value={d.name}>
            {d.name}
          </MenuItem>
        ))}
      </TextField>
      <TextField select size="small" fullWidth label={t("Column")} disabled={!side.dataset} value={side.column} onChange={(e) => set({ ...side, column: e.target.value })} slotProps={{ inputLabel: { shrink: true } }}>
        {columnsIn(found, side.dataset).map((c) => (
          <MenuItem key={c.name} value={c.name}>
            {c.name}
          </MenuItem>
        ))}
      </TextField>
    </Stack>
  );

  const ready = left.column && right.column && left.dataset !== right.dataset && !busy;
  return (
    <>
      <DialogTitle>{t("Relationships")}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 0.5 }}>
          {focus.length === 2 && <Alert severity="info">{t("{{a}} and {{b}} are not related yet. Connect them to use their fields together.", { a: focus[0], b: focus[1] })}</Alert>}
          {problem && (
            <Alert severity="error" onClose={() => setProblem(null)}>
              {problem}
            </Alert>
          )}
          {suggestions.length > 0 && (
            <Stack spacing={1}>
              <Typography sx={HEADING}>{t("Suggested")}</Typography>
              {suggestions.map((s) => (
                <Box key={`${refText(s.a)}|${refText(s.b)}`} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <Typography sx={{ ...MONO, flex: 1, minWidth: 0 }}>
                    {refText(s.a)} = {refText(s.b)}
                  </Typography>
                  <Button size="small" variant="outlined" disabled={busy} onClick={() => void connect(s.a, s.b)}>
                    {t("Connect")}
                  </Button>
                </Box>
              ))}
            </Stack>
          )}
          <Stack spacing={1}>
            <Typography sx={HEADING}>{t("Connect two tables")}</Typography>
            <Box sx={{ display: "flex", gap: 1.5, alignItems: "flex-start" }}>
              {sidePicker(left, setLeft, t("Table"))}
              {sidePicker(right, setRight, t("Table"))}
            </Box>
            <Typography sx={{ fontSize: 12, color: "text.secondary" }}>{t("Pick the column both tables share. One of the two must have one row per value.")}</Typography>
            <Box>
              <Button size="small" variant="contained" disabled={!ready} onClick={() => void connect(left, right)}>
                {t("Connect")}
              </Button>
            </Box>
          </Stack>
          <Stack spacing={0.5}>
            <Typography sx={HEADING}>{t("Connected")}</Typography>
            {made.length === 0 && <Typography sx={{ fontSize: 13, color: "text.secondary" }}>{t("None yet")}</Typography>}
            {made.map((r) => (
              <Box key={r.span.from} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Typography sx={{ ...MONO, flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 0.5, flexWrap: "wrap" }}>
                  {refText(r.many)}
                  <ArrowForwardOutlined aria-label={t("points at")} sx={{ fontSize: 14 }} />
                  {refText(r.one)}
                </Typography>
                <IconButton size="small" aria-label={`${t("Remove")} ${refText(r.many)}`} onClick={() => void setSource(removeRelationship(source, r))}>
                  <DeleteOutline fontSize="small" />
                </IconButton>
              </Box>
            ))}
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("Done")}</Button>
      </DialogActions>
    </>
  );
}

/** How the dashboard's datasets connect, made here: suggestions from their columns, or any two columns; `focus`: the datasets it was opened for. */
export function RelationshipsDialog({ open, ...form }: { open: boolean; slug: string; focus: string[]; datasets: Dataset[]; found: FoundColumns; load(name: string): Promise<ColumnInfo[]>; onClose(): void }) {
  return (
    <Dialog open={open} onClose={form.onClose} maxWidth="sm" fullWidth>
      {open && <Form key={form.focus.join()} {...form} />}
    </Dialog>
  );
}
