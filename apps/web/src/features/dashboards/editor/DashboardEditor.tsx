"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import type { ColumnInfo } from "@iara/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { IaraPanel } from "@/features/iara/IaraPanel";
import type { IaraAdapter } from "@/features/iara/types";
import { drafts } from "@/features/queries/drafts";
import { ErrorState } from "@/features/shell/PageHeader";
import { useNotify } from "@/features/shell/notify";
import { useShell } from "@/features/shell/ShellProvider";
import type { ModelLayout } from "@/lib/dashboards/modelLayout";
import { pickableIds } from "@/lib/dashboards/query";
import type { CrossPicks, DashboardConfig, Dataset, FilterValues, LayoutItem, Recipe, Widget } from "@/lib/dashboards/types";
import { newWidgetId } from "@/lib/dashboards/widgets";
import { checkModel } from "@/lib/model/check";
import { catalogSchema } from "@/server/actions/catalog";
import type { ActionResult } from "@/server/result";
import {
  deleteDatasetAction,
  deleteWidgetAction,
  openDashboard,
  runDraft,
  saveConfigAction,
  saveDatasetAction,
  saveLayoutAction,
  saveModelAction,
  saveModelLayoutAction,
  saveRecipeAction,
  saveWidgetAction,
  type OpenedDashboard,
} from "@/server/actions/dashboards";

import { useDashboardData } from "../canvas/useDashboardData";
import { CanvasTab } from "./CanvasTab";
import { applyDashboardOps, dashboardContext, outcomeOf, type DashboardIo } from "./dashboardIara";
import { DataTab } from "./DataTab";
import { EditorHeader } from "./EditorHeader";
import { ModelDiagram } from "./ModelDiagram";
import { newLayoutItem, newWidget, sameLayout, type NewKind } from "./newWidget";
import { PublishDialog } from "./PublishDialog";
import { RefreshDialog } from "./RefreshDialog";
import { SettingsDialog } from "./SettingsDialog";
import { useDatasetColumns, useReadColumns } from "./useDatasetColumns";
import { useDebouncedSave } from "./useDebouncedSave";
import { ModelContext, modelSchema } from "./useModel";

type Tab = "canvas" | "data" | "model";
type Schema = Record<string, { name: string; type: string }[]>;

const WIDGET_SAVE_MS = 400;
const LAYOUT_SAVE_MS = 500;
const LAYOUT = "layout";
const MODEL = "model";
/** a change to the model is saved 800 ms after the last one */
const MODEL_SAVE_MS = 800;
/** the Data tab's editor saves 800 ms after the last keystroke: datasets are read back once it has */
const DATASET_SAVE_SETTLE_MS = 1000;

/** The dashboard's files, for an approved change: each step throws with the reason it could not be done. */
function iaraIo(slug: string): DashboardIo {
  const done = async (r: Promise<ActionResult<unknown>>) => {
    const out = await r;
    if (!out.ok) throw new Error(out.error.message);
  };
  return {
    saveDataset: (name, text) => done(saveDatasetAction(slug, name, text)),
    deleteDataset: (name) => done(deleteDatasetAction(slug, name)),
    saveModel: (source) => done(saveModelAction(slug, source)),
    saveWidget: (widget) => done(saveWidgetAction(slug, widget)),
    deleteWidget: (id) => done(deleteWidgetAction(slug, id)),
    saveLayout: (items) => done(saveLayoutAction(slug, items)),
    newId: newWidgetId,
  };
}

function Editor({ slug, opened }: { slug: string; opened: OpenedDashboard }) {
  const { t } = useTranslation();
  const notify = useNotify();
  // the dashboard as the editor shows it: edits land here first, then on disk
  const [dashboard, setDashboard] = useState(opened.dashboard);
  const [published, setPublished] = useState(opened.published);
  // the model's source: saved as it is typed (see modelSaver)
  const [model, setModel] = useState(opened.dashboard.model);
  const [tab, setTab] = useState<Tab>("canvas");
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"settings" | "schedule" | "publish" | null>(null);
  const { iaraOpen, setIaraOpen } = useShell();
  const [modelLayout, setModelLayout] = useState(opened.dashboard.modelLayout ?? {});
  const [datasetsVersion, setDatasetsVersion] = useState(0);
  const [schema, setSchema] = useState<Schema | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const latest = useRef(dashboard);
  latest.current = dashboard;
  // an edit that changes what the widgets show is waiting to be saved
  const staleData = useRef(false);
  // a recipe was saved from the Data tab since the canvas last ran
  const recipeSaved = useRef(false);

  const load = useCallback((values: FilterValues, cross: CrossPicks) => runDraft(slug, values, cross), [slug]);
  // widgets that go away (or stop being a chart that can be picked) take their pick with them, or the next run is refused
  const pickable = useMemo(() => pickableIds(dashboard.widgets), [dashboard.widgets]);
  const data = useDashboardData(load, reloadKey, pickable);
  const columns = useDatasetColumns(slug, dashboard.datasets);
  // the model as checked against the columns read so far (a dataset not read yet takes any column name)
  const modelColumns = useMemo(() => modelSchema(dashboard.datasets, columns.found), [dashboard.datasets, columns.found]);
  const checked = useMemo(() => checkModel(model, modelColumns), [model, modelColumns]);
  const toast = (message: string) => notify(message, "error");
  const rerun = () => setReloadKey((k) => k + 1);

  const widgetSaver = useDebouncedSave<Widget>(async (_id, widget) => {
    const r = await saveWidgetAction(slug, widget);
    if (!r.ok) return toast(r.error.message);
    if (staleData.current) {
      staleData.current = false;
      rerun();
    }
  }, WIDGET_SAVE_MS);
  const layoutSaver = useDebouncedSave<LayoutItem[]>(async (_key, items) => {
    const r = await saveLayoutAction(slug, items);
    if (!r.ok) toast(r.error.message);
  }, LAYOUT_SAVE_MS);
  const modelSaver = useDebouncedSave<string>(async (_key, source) => {
    const r = await saveModelAction(slug, source);
    if (!r.ok) return toast(r.error.message);
    // the widgets with measures draw them again from the saved model
    if (staleData.current) {
      staleData.current = false;
      rerun();
    }
  }, MODEL_SAVE_MS);
  const modelLayoutSaver = useDebouncedSave<ModelLayout>(async (_key, places) => {
    const r = await saveModelLayoutAction(slug, places);
    if (!r.ok) toast(r.error.message);
  }, LAYOUT_SAVE_MS);
  const changeModelLayout = (places: ModelLayout) => {
    setModelLayout(places);
    modelLayoutSaver.schedule(LAYOUT, places);
  };
  const flushSaves = () => Promise.all([widgetSaver.flush(), layoutSaver.flush(), modelSaver.flush(), modelLayoutSaver.flush()]);

  // the catalog's tables, for the SQL editor and "From a table", the first time the Data tab is shown
  useEffect(() => {
    if (tab === "data" && schema === null) void catalogSchema().then((r) => setSchema(r.ok ? r.data : {}));
  }, [tab, schema]);

  /** Read the folder back after something failed: what is on disk is the truth. */
  const reload = async () => {
    await flushSaves();
    const r = await openDashboard(slug);
    if (!r.ok) return toast(r.error.message);
    setDashboard(r.data.dashboard);
    setPublished(r.data.published);
    setModel(r.data.dashboard.model);
    setModelLayout(r.data.dashboard.modelLayout ?? {});
    rerun();
  };

  /** Read the datasets back (the Data tab saves its own files). Whether they changed. */
  const syncDatasets = async () => {
    const r = await openDashboard(slug);
    if (!r.ok) {
      toast(r.error.message);
      return false;
    }
    const { datasets, problems } = r.data.dashboard;
    const changed = JSON.stringify(datasets) !== JSON.stringify(latest.current.datasets);
    setDashboard((d) => ({ ...d, datasets: changed ? datasets : d.datasets, problems }));
    return changed;
  };

  const changeTab = (next: Tab) => {
    setTab(next);
    if (tab !== "data" || next !== "canvas") return;
    setTimeout(
      () =>
        void syncDatasets().then((changed) => {
          if (changed || recipeSaved.current) rerun();
          recipeSaved.current = false;
        }),
      DATASET_SAVE_SETTLE_MS,
    );
  };

  const refresh = async () => {
    await flushSaves();
    await syncDatasets();
    data.refresh();
  };

  const changeConfig = async (config: DashboardConfig) => {
    const before = latest.current.config;
    setDashboard((d) => ({ ...d, config }));
    const r = await saveConfigAction(slug, config);
    if (!r.ok) {
      toast(r.error.message);
      setDashboard((d) => ({ ...d, config: before }));
      return;
    }
    // the dashboard runs on another cluster now
    if (before.cluster !== config.cluster) rerun();
  };

  const changeWidget = (widget: Widget, reload = widget.kind !== "text") => {
    setDashboard((d) => ({ ...d, widgets: d.widgets.map((w) => (w.id === widget.id ? widget : w)) }));
    if (reload) {
      staleData.current = true;
      // a value typed for the old settings may not fit the new ones
      if (widget.kind === "filter") data.setValue(widget.id, undefined);
      // so may the category picked in a chart whose dataset or x column changed
      const was = latest.current.widgets.find((w) => w.id === widget.id);
      if (widget.kind === "chart" && was?.kind === "chart" && (was.dataset !== widget.dataset || was.spec.x !== widget.spec.x)) data.setPick(widget.id, undefined);
    }
    widgetSaver.schedule(widget.id, widget);
  };

  const changeLayout = (items: LayoutItem[]) => {
    if (sameLayout(items, latest.current.layout)) return;
    setDashboard((d) => ({ ...d, layout: items }));
    layoutSaver.schedule(LAYOUT, items);
  };

  /**
   * `now`: saved at once, and resolved when it has been. The widget settings add a measure that way and then
   * change the chart to draw it: that save runs the dashboard, so this one does not (nothing draws the measure yet).
   */
  const changeModel = useCallback(
    async (source: string, now = false) => {
      setModel(source);
      modelSaver.schedule(MODEL, source);
      if (!now) staleData.current = true;
      else await modelSaver.flush();
    },
    [modelSaver],
  );
  const modelState = useMemo(() => ({ model: checked.model, source: model, setSource: changeModel }), [checked.model, model, changeModel]);

  const addWidget = async (kind: NewKind) => {
    const dataset = latest.current.datasets[0]?.name ?? "";
    let found: ColumnInfo[] = [];
    if (dataset && (kind === "chart" || kind === "filter")) {
      try {
        found = await columns.load(dataset);
      } catch (e) {
        toast((e as Error).message);
      }
    }
    const widget = newWidget(kind, newWidgetId(), dataset, found);
    if (!widget) return toast(t("The first dataset has no columns to filter by."));
    const layout = [...latest.current.layout, newLayoutItem(latest.current.layout, widget)];
    setDashboard((d) => ({ ...d, widgets: [...d.widgets, widget], layout }));
    setSelected(widget.id);
    // this layout holds everything the pending one did
    layoutSaver.cancel(LAYOUT);
    const saved = await saveWidgetAction(slug, widget);
    const placed = saved.ok ? await saveLayoutAction(slug, layout) : saved;
    if (!placed.ok) {
      toast(placed.error.message);
      return void reload();
    }
    rerun();
  };

  const removeWidget = async (id: string) => {
    const gone = latest.current.widgets.find((w) => w.id === id);
    const layout = latest.current.layout.filter((i) => i.widget !== id);
    widgetSaver.cancel(id);
    setDashboard((d) => ({ ...d, widgets: d.widgets.filter((w) => w.id !== id), layout }));
    setSelected((s) => (s === id ? null : s));
    // replaces a pending layout save, which still has the widget
    layoutSaver.schedule(LAYOUT, layout);
    const r = await deleteWidgetAction(slug, id);
    if (!r.ok) {
      toast(r.error.message);
      return void reload();
    }
    // a filter's value goes with it, or the next run is refused
    if (gone?.kind === "filter") {
      data.setValue(id, undefined);
      rerun();
    }
  };

  /** Puts a dataset in the list, in place of the one with its name. */
  const putDataset = (dataset: Dataset) =>
    setDashboard((d) => ({ ...d, datasets: [...d.datasets.filter((x) => x.name !== dataset.name), dataset].sort((a, b) => (a.name < b.name ? -1 : 1)) }));

  const addDataset = async (name: string, content: string | Recipe) => {
    const r = typeof content === "string" ? await saveDatasetAction(slug, name, content) : await saveRecipeAction(slug, name, content);
    if (!r.ok) {
      toast(r.error.message);
      return false;
    }
    putDataset(r.data);
    return true;
  };

  /** A recipe dataset's steps, as the Data tab saves them. */
  const saveRecipe = async (name: string, recipe: Recipe) => {
    const r = await saveRecipeAction(slug, name, recipe);
    if (!r.ok) return toast(r.error.message);
    putDataset(r.data);
    // the state already holds it, so reading the datasets back finds no change: tell the canvas
    recipeSaved.current = true;
  };

  const removeDataset = async (name: string) => {
    const r = await deleteDatasetAction(slug, name);
    if (!r.ok) return toast(r.error.message);
    setDashboard((d) => ({ ...d, datasets: d.datasets.filter((x) => x.name !== name) }));
    rerun();
  };

  const problems = dashboard.problems;

  // Iara reads the editor as it is at each message, and an approved change goes to the files, which are then read back
  const live = useRef({ dashboard, model, found: columns.found, tab, selected, result: data.result, reload, flushSaves });
  useEffect(() => {
    live.current = { dashboard, model, found: columns.found, tab, selected, result: data.result, reload, flushSaves };
  });
  // the columns she is told about
  useReadColumns(dashboard.datasets, columns.found, columns.load, iaraOpen);
  const iara = useMemo(() => {
    const getContext = () => {
      const now = live.current;
      return dashboardContext({ dashboard: now.dashboard, model: now.model, found: now.found, view: now.tab, selected: now.selected, result: now.result });
    };
    const adapter: IaraAdapter = {
      async apply(change, run) {
        if (change.action !== "edit_dashboard") throw new Error("not possible in a dashboard");
        const now = live.current;
        await now.flushSaves();
        const before = now.result;
        // what the SQL editor holds of a dataset would write over the new query
        for (const op of change.operations) if (op.op === "set_dataset") drafts.delete(`dashboards/${slug}/datasets/${op.name}.sql`);
        try {
          await applyDashboardOps(change.operations, { datasets: now.dashboard.datasets, layout: now.dashboard.layout, model: now.model }, iaraIo(slug));
        } finally {
          setDatasetsVersion((n) => n + 1);
          await live.current.reload();
        }
        if (!run) return { applied: true, ran: false };
        const opened = await openDashboard(slug);
        const rendered = await runDraft(slug, {}, []);
        if (!opened.ok || !rendered.ok) return { applied: true, ran: false };
        return outcomeOf(opened.data.dashboard.widgets, before, rendered.data);
      },
    };
    return { getContext, adapter };
  }, [slug]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <EditorHeader
        config={dashboard.config}
        published={published}
        loading={data.loading}
        onConfig={(config) => void changeConfig(config)}
        onRefresh={() => void refresh()}
        onSettings={() => setDialog("settings")}
        onSchedule={() => setDialog("schedule")}
        iaraOpen={iaraOpen}
        onIara={() => setIaraOpen(!iaraOpen)}
        // the copy is made from the files: what is waiting to be saved goes first
        onPublish={() => void flushSaves().then(() => setDialog("publish"))}
      />
      <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>
        <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 }}>
          <Box sx={{ px: 2, borderBottom: 1, borderColor: "divider", bgcolor: "background.paper", flexShrink: 0 }}>
            <Tabs value={tab} onChange={(_, next: Tab) => changeTab(next)} aria-label={t("Dashboard sections")}>
              <Tab value="canvas" label={t("Canvas")} />
              <Tab value="data" label={t("Data")} />
              <Tab value="model" label={t("Model")} />
            </Tabs>
          </Box>
          {problems.length > 0 && (
            <Alert severity="warning" sx={{ borderRadius: 0, flexShrink: 0 }}>
              {problems.map((p) => (
                <div key={p.file}>
                  {p.file}: {p.error}
                </div>
              ))}
            </Alert>
          )}
          <ModelContext.Provider value={modelState}>
            {tab === "canvas" && (
              <CanvasTab
                dashboard={dashboard}
                data={data}
                selected={selected}
                found={columns.found}
                load={columns.load}
                onSelect={setSelected}
                onAdd={(kind) => void addWidget(kind)}
                onChange={changeWidget}
                onLayout={changeLayout}
                onRemove={(id) => void removeWidget(id)}
              />
            )}
            {tab === "model" && (
              <ModelDiagram slug={slug} datasets={dashboard.datasets} found={columns.found} load={columns.load} layout={modelLayout} onLayout={changeModelLayout} />
            )}
            <DataTab
              slug={slug}
              kernelKey={`dashboard:${dashboard.config.id}`}
              datasets={dashboard.datasets}
              widgets={dashboard.widgets}
              found={columns.found}
              load={columns.load}
              shown={tab === "data"}
              schema={schema}
              onAdd={addDataset}
              onSaveRecipe={saveRecipe}
              onDelete={(name) => void removeDataset(name)}
              onDatasetSaved={putDataset}
              onWidget={changeWidget}
              version={datasetsVersion}
            />
          </ModelContext.Provider>
        </Box>
        {iaraOpen && <IaraPanel fileId={`dashboard:${dashboard.config.id}`} surface="dashboard" getContext={iara.getContext} adapter={iara.adapter} onClose={() => setIaraOpen(false)} />}
      </Box>
      <SettingsDialog open={dialog === "settings"} config={dashboard.config} onSave={(config) => void changeConfig(config)} onClose={() => setDialog(null)} />
      <RefreshDialog open={dialog === "schedule"} slug={slug} config={dashboard.config} published={published !== null} onSave={(config) => void changeConfig(config)} onClose={() => setDialog(null)} />
      <PublishDialog open={dialog === "publish"} slug={slug} published={published} onChange={setPublished} onClose={() => setDialog(null)} />
    </Box>
  );
}

/** The editor of the dashboard `slug`: its canvas, its datasets, publishing. */
export function DashboardEditor({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState<OpenedDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void openDashboard(slug).then((r) => {
      if (!current) return;
      if (r.ok) setOpened(r.data);
      else setError(r.error.message);
    });
    return () => {
      current = false;
    };
  }, [slug]);

  if (error) return <ErrorState title={t("Could not open the dashboard")} message={error} />;
  if (opened?.dashboard.slug !== slug) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", pt: 8 }}>
        <CircularProgress size={22} />
      </Box>
    );
  }
  return <Editor key={slug} slug={slug} opened={opened} />;
}
