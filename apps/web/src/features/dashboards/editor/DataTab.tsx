"use client";

import DeleteOutline from "@mui/icons-material/DeleteOutlineOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Typography from "@mui/material/Typography";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { SqlFileTab } from "@/features/queries/SqlFileTab";
import { type WranglerStep, WranglerView } from "@/features/wrangler";
import type { Dataset, Recipe } from "@/lib/dashboards/types";

import { AddDatasetMenu } from "./AddDatasetMenu";
import { tableNames } from "./datasets";
import { useDebouncedSave } from "./useDebouncedSave";

const NO_SCHEMA: Record<string, { name: string; type: string }[]> = {};
const RECIPE_SAVE_MS = 800;

/**
 * The datasets: a list on the left and, for the one picked, its query in the
 * SQL editor (a dataset is a `.sql` file of the dashboard's folder, saved as you type),
 * or the wrangler of a recipe dataset (saved as its steps change).
 */
export function DataTab({
  slug,
  kernelKey,
  datasets,
  shown,
  schema,
  onAdd,
  onSaveRecipe,
  onDelete,
}: {
  slug: string;
  /** the kernel the wrangler runs its recipes on */
  kernelKey: string;
  datasets: Dataset[];
  /** the tab is on screen (it stays mounted when it is not, so the editor keeps its state) */
  shown: boolean;
  /** tables and their columns, null until read */
  schema: Record<string, { name: string; type: string }[]> | null;
  onAdd(name: string, content: string | Recipe): Promise<boolean>;
  onSaveRecipe(name: string, recipe: Recipe): Promise<void>;
  onDelete(name: string): void;
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const current = datasets.find((d) => d.name === picked)?.name ?? datasets[0]?.name;
  const recipe = datasets.find((d) => d.name === current)?.recipe;
  const tables = schema && tableNames(schema);
  // per dataset: a recipe still waiting to be saved goes on while another is picked
  const recipeSaver = useDebouncedSave<Recipe>(onSaveRecipe, RECIPE_SAVE_MS);

  return (
    <Box sx={{ display: shown ? "flex" : "none", flex: 1, minHeight: 0 }}>
      <Box sx={{ width: 260, flexShrink: 0, display: "flex", flexDirection: "column", borderRight: 1, borderColor: "divider", bgcolor: "background.paper" }}>
        <Box sx={{ p: 1.5 }}>
          <AddDatasetMenu
            taken={datasets.map((d) => d.name)}
            tables={tables}
            onCreate={async (name, content) => {
              const ok = await onAdd(name, content);
              if (ok) setPicked(name);
              return ok;
            }}
          />
        </Box>
        <List dense sx={{ overflow: "auto", flex: 1 }} aria-label={t("Datasets")}>
          {datasets.map((d) => (
            <ListItem
              key={d.name}
              disablePadding
              secondaryAction={
                <IconButton edge="end" size="small" aria-label={`${t("Delete dataset")} ${d.name}`} onClick={() => setDeleting(d.name)}>
                  <DeleteOutline fontSize="small" />
                </IconButton>
              }
            >
              <ListItemButton selected={d.name === current} onClick={() => setPicked(d.name)}>
                <ListItemText
                  primary={d.name}
                  secondary={d.recipe ? t("No code") : null}
                  slotProps={{ primary: { noWrap: true, sx: { fontFamily: "var(--font-mono, monospace)", fontSize: 13 } }, secondary: { sx: { fontSize: 11 } } }}
                />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      </Box>
      <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {recipe ? (
          <WranglerView
            key={current}
            kernelKey={kernelKey}
            source={recipe.source}
            label={recipe.source.table}
            height="100%"
            // the protocol's steps are the wrangler's steps, typed more loosely
            initialSteps={recipe.steps as WranglerStep[]}
            onSteps={(steps) => recipeSaver.schedule(current, { source: recipe.source, steps })}
          />
        ) : current ? (
          <SqlFileTab key={current} path={`dashboards/${slug}/datasets/${current}.sql`} shown={shown} schema={schema ?? NO_SCHEMA} />
        ) : (
          <Box sx={{ textAlign: "center", py: 8, px: 3, color: "text.secondary" }}>
            <Typography variant="h4" sx={{ color: "text.primary" }}>
              {t("No datasets yet")}
            </Typography>
          </Box>
        )}
      </Box>
      <Dialog open={deleting !== null} onClose={() => setDeleting(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{t("Delete {{name}}?", { name: deleting })}</DialogTitle>
        <DialogActions>
          <Button onClick={() => setDeleting(null)}>{t("Cancel")}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              // a recipe still waiting to be saved would bring its file back
              recipeSaver.cancel(deleting!);
              onDelete(deleting!);
              setDeleting(null);
            }}
          >
            {t("Delete")}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
