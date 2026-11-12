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
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { ColumnInfo } from "@iara/protocol";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { drafts } from "@/features/queries/drafts";
import { SqlFileTab } from "@/features/queries/SqlFileTab";
import { useNotify } from "@/features/shell/notify";
import { type WranglerStep, WranglerView } from "@/features/wrangler";
import type { Dataset, Recipe, Widget } from "@/lib/dashboards/types";
import { setDatasetMode } from "@/server/actions/extracts";
import { saveQuery } from "@/server/actions/queries";

import { AddDatasetMenu } from "./AddDatasetMenu";
import { DatasetModeButton, DatasetModeLine } from "./DatasetModeLine";
import { tableNames } from "./datasets";
import { FormulaBar } from "./FormulaBar";
import { MeasureList } from "./MeasureList";
import { RelationshipsDialog } from "./RelationshipsDialog";
import type { FoundColumns } from "./useDatasetColumns";
import { useDebouncedSave } from "./useDebouncedSave";
import { useExtractStatus } from "./useExtractStatus";
import { useFormulaBar } from "./useFormulaBar";
import { useMeasureActions } from "./useMeasureActions";
import { useModel } from "./useModel";

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
  onDatasetSaved,
  widgets,
  found,
  load,
  onWidget,
  version,
}: {
  /** bumped when something other than the SQL editor wrote the datasets' files: it reads them again */
  version: number;
  /** the widgets that draw the measures made here */
  widgets: Widget[];
  found: FoundColumns;
  load(name: string): Promise<ColumnInfo[]>;
  onWidget(widget: Widget, reload?: boolean): void;
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
  /** a dataset saved with a new mode: the editor's copy of it is replaced */
  onDatasetSaved?(dataset: Dataset): void;
}) {
  const { t } = useTranslation();
  const notify = useNotify();
  const [picked, setPicked] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  // bumped on a mode change: the SQL editor then reads its file again (its copy has the old mode line)
  const [reopened, setReopened] = useState(0);
  const current = datasets.find((d) => d.name === picked)?.name ?? datasets[0]?.name;
  const recipe = datasets.find((d) => d.name === current)?.recipe;
  const tables = schema && tableNames(schema);
  // per dataset: a recipe still waiting to be saved goes on while another is picked
  const recipeSaver = useDebouncedSave<Recipe>(onSaveRecipe, RECIPE_SAVE_MS);
  const { statuses, refresh: refreshStatuses } = useExtractStatus(slug, datasets, shown);
  const formula = useFormulaBar();
  const measures = useMeasureActions(widgets, undefined, onWidget);
  // null: closed; a dataset: it was just added, so its suggestions come first
  const [relating, setRelating] = useState<string[] | null>(null);
  const [side, setSide] = useState<"datasets" | "measures">("datasets");
  const [search, setSearch] = useState("");
  const { measures: allMeasures } = useModel();
  const shownDatasets = datasets.filter((d) => d.name.toLowerCase().includes(search.trim().toLowerCase()));

  /** Imported or live: saved to the dataset's file, then the statuses are read again. */
  const changeMode = async (name: string, mode: "extract" | "live") => {
    const path = `dashboards/${slug}/datasets/${name}.sql`;
    // a save still waiting would write the old mode back
    await recipeSaver.flush();
    const draft = drafts.get(path);
    if (draft && draft.text !== draft.saved) {
      const saved = await saveQuery(path, draft.text);
      if (!saved.ok) return notify(saved.error.message, "error");
      draft.saved = draft.text;
    }
    const r = await setDatasetMode(slug, name, mode);
    if (!r.ok) return notify(r.error.message, "error");
    drafts.delete(path);
    setReopened((n) => n + 1);
    onDatasetSaved?.(r.data);
    void refreshStatuses();
  };

  return (
    <Box sx={{ display: shown ? "flex" : "none", flex: 1, minHeight: 0 }}>
      <Box sx={{ width: 260, flexShrink: 0, display: "flex", flexDirection: "column", borderRight: 1, borderColor: "divider", bgcolor: "background.paper" }}>
        <Tabs value={side} onChange={(_, next: "datasets" | "measures") => { setSide(next); setSearch(""); }} variant="fullWidth" aria-label={t("Data")} sx={{ minHeight: 40, flexShrink: 0, borderBottom: 1, borderColor: "divider", "& .MuiTab-root": { minHeight: 40, py: 0, textTransform: "none" } }}>
          <Tab value="datasets" label={`${t("Datasets")} (${datasets.length})`} />
          <Tab value="measures" label={`${t("Measures")} (${allMeasures.length})`} />
        </Tabs>
        <Box sx={{ display: side === "datasets" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <Stack spacing={1} sx={{ p: 1.5 }}>
            <AddDatasetMenu
              taken={datasets.map((d) => d.name)}
              tables={tables}
              onCreate={async (name, content) => {
                const ok = await onAdd(name, content);
                if (ok) setPicked(name);
                // a new table is ready to be connected to the others
                if (ok && datasets.length > 0) setRelating([name]);
                return ok;
              }}
            />
            <TextField size="small" fullWidth value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("Search")} slotProps={{ htmlInput: { "aria-label": t("Search datasets") } }} />
          </Stack>
          <List dense sx={{ overflow: "auto", flex: 1, minHeight: 0 }} aria-label={t("Datasets")}>
            {shownDatasets.map((d) => (
              <ListItem
                key={d.name}
                disablePadding
                // room for two icons: the list item only leaves 48px for one
                sx={{ "& > .MuiListItemButton-root": { pr: 9 } }}
                secondaryAction={
                  <Box sx={{ display: "flex", alignItems: "center" }}>
                    {statuses[d.name] && <DatasetModeButton name={d.name} status={statuses[d.name]} onChange={(mode) => void changeMode(d.name, mode)} />}
                    <IconButton edge="end" size="small" aria-label={`${t("Delete dataset")} ${d.name}`} onClick={() => setDeleting(d.name)}>
                      <DeleteOutline fontSize="small" />
                    </IconButton>
                  </Box>
                }
              >
                <ListItemButton selected={d.name === current} onClick={() => setPicked(d.name)}>
                  <ListItemText
                    primary={d.name}
                    secondary={<DatasetModeLine status={statuses[d.name]} />}
                    slotProps={{ primary: { noWrap: true, sx: { fontFamily: "var(--font-mono, monospace)", fontSize: 13 } }, secondary: { sx: { fontSize: 11 } } }}
                  />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        </Box>
        {side === "measures" && <MeasureList datasets={datasets} widgets={widgets} formula={formula} actions={measures} />}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {shown && formula.target && <FormulaBar key={formula.target.key} target={formula.target} datasets={datasets} found={found} load={load} actions={measures} onClose={formula.close} />}
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
          <SqlFileTab key={`${current}:${reopened}:${version}`} path={`dashboards/${slug}/datasets/${current}.sql`} shown={shown} schema={schema ?? NO_SCHEMA} ownIara={false} />
        ) : (
          <Box sx={{ textAlign: "center", py: 8, px: 3, color: "text.secondary" }}>
            <Typography variant="h4" sx={{ color: "text.primary" }}>
              {t("No datasets yet")}
            </Typography>
          </Box>
        )}
      </Box>
      <RelationshipsDialog open={relating !== null} slug={slug} focus={relating ?? []} datasets={datasets} found={found} load={load} onClose={() => setRelating(null)} />
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
