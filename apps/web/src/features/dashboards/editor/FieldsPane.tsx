"use client";

import Add from "@mui/icons-material/Add";
import ChevronLeftOutlined from "@mui/icons-material/ChevronLeftOutlined";
import ChevronRightOutlined from "@mui/icons-material/ChevronRightOutlined";
import SearchOutlined from "@mui/icons-material/SearchOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { ColumnInfo } from "@iara/protocol";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Dataset, Widget } from "@/lib/dashboards/types";
import { isNumericType } from "@/lib/format";
import type { Model } from "@/lib/model/types";

import type { FieldRef } from "../canvas/fieldDrag";
import { DeleteMeasureDialog } from "./DeleteMeasureDialog";
import { toggleField } from "./fieldActions";
import { FieldMenu, type FieldCommand, type FieldTarget } from "./FieldMenu";
import type { MenuAnchor } from "./FieldRow";
import { buildFieldTree, type FieldNode } from "./fieldTree";
import { FieldTreeView } from "./FieldTreeView";
import { widgetLabel } from "./newWidget";
import { QuickMeasureDialog } from "./QuickMeasureDialog";
import type { QuickInitial } from "./quickMeasures";
import { columnsIn, useReadColumns, type FoundColumns } from "./useDatasetColumns";
import type { FormulaBarControl } from "./useFormulaBar";
import type { MeasureActions } from "./useMeasureActions";
import { modelSchema, useModel } from "./useModel";
import { usePersistedFlag } from "./usePersistedFlag";

const STORAGE_KEY = "iara.dashboards.fields-pane";
const WIDTH = 260;

/** The template and fields the Quick measure dialog opens on for an item of the tree. */
function quickFor(target: FieldTarget, model: Model): QuickInitial {
  if (target.kind === "dataset") return { kind: "rows", dataset: target.name };
  if (target.kind === "column") return { kind: isNumericType(target.type) ? "sum" : "distinct", dataset: target.dataset, column: target.name };
  return { kind: "percent", measure: target.name, dataset: model.measures.find((m) => m.name === target.name)?.datasets[0] };
}

/**
 * Everything the model offers, always at hand on the canvas: datasets with their columns and measures, calendars,
 * parameters. Measures are made here (the formula bar, Quick measure), and a field is put on the selected widget
 * with its checkbox, or on any widget by dragging it there.
 */
export function FieldsPane({
  datasets,
  found,
  load,
  widget,
  onChange,
  formula,
  actions,
}: {
  datasets: Dataset[];
  found: FoundColumns;
  load(name: string): Promise<ColumnInfo[]>;
  /** the selected widget */
  widget: Widget | undefined;
  onChange(widget: Widget, reload?: boolean): void;
  formula: FormulaBarControl;
  actions: MeasureActions;
}) {
  const { t } = useTranslation();
  const model = useModel();
  const [shown, setShown] = usePersistedFlag(STORAGE_KEY, true);
  const [query, setQuery] = useState("");
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ target: FieldTarget; anchor: MenuAnchor } | null>(null);
  const [quick, setQuick] = useState<QuickInitial | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const tree = useMemo(() => buildFieldTree({ datasets, model, found, query }), [datasets, model, found, query]);
  const schema = useMemo(() => modelSchema(datasets, found), [datasets, found]);

  // a search looks in every dataset's columns: they are read once it starts
  useReadColumns(datasets, found, load, query.trim() !== "");

  const toggle = (node: FieldNode) => {
    const now = !(opened[node.name] || node.open);
    setOpened((o) => ({ ...o, [node.name]: now }));
    // a dataset's columns are read when it opens (again if they could not be)
    if (now && node.kind === "dataset" && (found[node.name] === undefined || typeof found[node.name] === "string")) load(node.name).catch(() => undefined);
  };

  const activate = (field: FieldRef) => {
    if (!widget) return;
    const columns = widget.kind === "table" ? columnsIn(found, widget.dataset).map((c) => c.name) : [];
    const next = toggleField(widget, field, columns);
    if (next) onChange(next);
  };

  const command = (what: FieldCommand, target: FieldTarget) => {
    if (what === "new") formula.openNew();
    else if (what === "quick") setQuick(quickFor(target, model));
    else if (target.kind !== "measure") return;
    else if (what === "edit") formula.openEdit(target.name);
    else if (what === "rename") formula.openEdit(target.name, "name");
    else setDeleting(target.name);
  };

  const label = (w: Widget) => (w.kind !== "text" && w.title) || t(widgetLabel(w));

  if (!shown) {
    return (
      <Box sx={{ width: 40, flexShrink: 0, borderLeft: 1, borderColor: "divider", bgcolor: "background.paper", display: "flex", justifyContent: "center", pt: 1 }}>
        <IconButton size="small" aria-label={t("Show fields")} onClick={() => setShown(true)}>
          <ChevronLeftOutlined fontSize="small" />
        </IconButton>
      </Box>
    );
  }

  const empty = !tree.nodes.length && !tree.loose.length && !tree.params.length;
  return (
    <Box component="aside" aria-label={t("Fields")} sx={{ width: WIDTH, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0, borderLeft: 1, borderColor: "divider", bgcolor: "background.paper" }}>
      <Box sx={{ display: "flex", alignItems: "center", pl: 2, pr: 1, minHeight: 48, borderBottom: 1, borderColor: "divider", flexShrink: 0 }}>
        <Typography sx={{ flex: 1, fontWeight: 650 }}>{t("Fields")}</Typography>
        <IconButton size="small" aria-label={t("Hide fields")} onClick={() => setShown(false)}>
          <ChevronRightOutlined fontSize="small" />
        </IconButton>
      </Box>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1, p: 1.5, flexShrink: 0 }}>
        <TextField
          size="small"
          fullWidth
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("Search fields")}
          slotProps={{
            htmlInput: { "aria-label": t("Search fields") },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchOutlined fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
        />
        <Button size="small" variant="outlined" startIcon={<Add />} aria-label={t("New measure")} onClick={() => formula.openNew()}>
          {t("Measure")}
        </Button>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {empty ? (
          <Typography sx={{ fontSize: 12, color: "text.secondary", px: 2, py: 1 }}>{query.trim() ? t("No results") : t("No datasets yet")}</Typography>
        ) : (
          <FieldTreeView
            tree={tree}
            widget={widget}
            isOpen={(node) => !!opened[node.name] || node.open}
            onToggle={toggle}
            onActivate={activate}
            onMenu={(target, anchor) => setMenu({ target, anchor })}
          />
        )}
      </Box>
      <FieldMenu open={menu} onClose={() => setMenu(null)} onCommand={command} />
      <QuickMeasureDialog
        open={quick !== null}
        datasets={datasets}
        found={found}
        load={load}
        schema={schema}
        initial={quick ?? undefined}
        onAdd={async (lines, name) => {
          await actions.add(lines, name);
          setQuick(null);
        }}
        onClose={() => setQuick(null)}
      />
      <DeleteMeasureDialog name={deleting} usedBy={deleting ? actions.usedBy(deleting).map(label) : []} onConfirm={() => actions.remove(deleting!)} onClose={() => setDeleting(null)} />
    </Box>
  );
}
