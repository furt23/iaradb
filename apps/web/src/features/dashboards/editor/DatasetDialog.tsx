"use client";

import Autocomplete from "@mui/material/Autocomplete";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { DATASET_NAME } from "@/lib/dashboards/query";
import type { Recipe } from "@/lib/dashboards/types";

import { datasetNameFor, tableQuery } from "./datasets";

export type DatasetMode = "sql" | "table" | "recipe";

interface FormProps {
  mode: DatasetMode;
  /** names of the datasets there already are */
  taken: string[];
  /** tables to pick from (null: still being read) */
  tables: string[] | null;
  /** adds the dataset: a SQL file's text, or a recipe (false: it could not be added, the reason was shown) */
  onCreate(name: string, content: string | Recipe): Promise<boolean>;
  onClose(): void;
}

function DatasetForm({ mode, taken, tables, onCreate, onClose }: FormProps) {
  const { t } = useTranslation();
  const [table, setTable] = useState<string | null>(null);
  // until the name is typed, it follows the table
  const [typed, setTyped] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = typed ?? (table ? datasetNameFor(table, taken) : "");
  const problem = name && !DATASET_NAME.test(name) ? t("Use lowercase letters, digits and _ (up to 64).") : taken.includes(name) ? t("There is already a dataset with this name.") : null;
  const ready = name !== "" && problem === null && (mode === "sql" || table !== null) && !busy;

  const create = async () => {
    if (!ready) return;
    setBusy(true);
    const content: string | Recipe = mode === "sql" ? "SELECT 1\n" : mode === "table" ? tableQuery(table!) : { source: { table: table! }, steps: [] };
    const ok = await onCreate(name, content);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <>
      <DialogTitle>{mode === "sql" ? t("New SQL dataset") : mode === "table" ? t("New dataset from a table") : t("New dataset from a cleaned table")}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {mode !== "sql" && (
            <Autocomplete
              options={tables ?? []}
              loading={tables === null}
              value={table}
              onChange={(_, value) => setTable(value)}
              noOptionsText={t("No tables")}
              renderInput={(params) => <TextField {...params} autoFocus label={t("Table")} />}
            />
          )}
          <TextField
            autoFocus={mode === "sql"}
            label={t("Dataset name")}
            value={name}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
            error={problem !== null}
            helperText={problem}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("Cancel")}</Button>
        <Button variant="contained" disabled={!ready} onClick={() => void create()}>
          {t("Add dataset")}
        </Button>
      </DialogActions>
    </>
  );
}

/** Names a new dataset: a SQL query to write, or a table to read whole or clean. */
export function DatasetDialog({ open, ...form }: FormProps & { open: boolean }) {
  return (
    <Dialog open={open} onClose={form.onClose} maxWidth="xs" fullWidth>
      <DatasetForm {...form} />
    </Dialog>
  );
}
