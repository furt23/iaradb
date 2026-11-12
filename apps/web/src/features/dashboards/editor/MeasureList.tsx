"use client";

import Add from "@mui/icons-material/Add";
import ChevronRightOutlined from "@mui/icons-material/ChevronRightOutlined";
import DeleteOutline from "@mui/icons-material/DeleteOutlineOutlined";
import ExpandMoreOutlined from "@mui/icons-material/ExpandMoreOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Dataset, Widget } from "@/lib/dashboards/types";
import type { Measure } from "@/lib/model/types";

import { DeleteMeasureDialog } from "./DeleteMeasureDialog";
import { buildFieldTree } from "./fieldTree";
import { widgetLabel } from "./newWidget";
import type { FormulaBarControl } from "./useFormulaBar";
import type { MeasureActions } from "./useMeasureActions";
import { useModel } from "./useModel";

const NO_COLUMNS = {};

/**
 * The model's measures on the Data tab, by the dataset each one reads first, so a long list stays readable: a search
 * looks through them all, and a dataset's group closes. A click puts a measure in the formula bar, with its format.
 */
export function MeasureList({ datasets, widgets, formula, actions }: { datasets: Dataset[]; widgets: Widget[]; formula: FormulaBarControl; actions: MeasureActions }) {
  const { t } = useTranslation();
  const model = useModel();
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState<string | null>(null);
  const tree = useMemo(() => buildFieldTree({ datasets, model, found: NO_COLUMNS, query }), [datasets, model, query]);
  const groups = [...tree.nodes.filter((n) => n.measures.length).map((n) => ({ name: n.name, measures: n.measures })), ...(tree.loose.length ? [{ name: t("Other measures"), measures: tree.loose }] : [])];
  const editing = formula.target?.mode === "edit" ? formula.target.name : undefined;
  const searching = query.trim() !== "";
  const label = (w: Widget) => (w.kind !== "text" && w.title) || t(widgetLabel(w));

  const flip = (name: string) =>
    setClosed((now) => {
      const next = new Set(now);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  const row = (m: Measure) => (
    <ListItem
      key={m.name}
      disablePadding
      secondaryAction={
        <IconButton edge="end" size="small" aria-label={`${t("Delete")} ${m.name}`} onClick={() => setDeleting(m.name)}>
          <DeleteOutline fontSize="small" />
        </IconButton>
      }
    >
      <ListItemButton selected={m.name === editing} onClick={() => formula.select(m.name)} sx={{ pl: 4 }}>
        <ListItemText primary={m.name} slotProps={{ primary: { noWrap: true, title: m.name, sx: { fontFamily: "var(--font-mono, monospace)", fontSize: 13 } } }} />
      </ListItemButton>
    </ListItem>
  );

  return (
    <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Stack spacing={1} sx={{ p: 1.5 }}>
        <Button size="small" variant="contained" fullWidth startIcon={<Add />} aria-label={t("New measure")} onClick={() => formula.openNew()}>
          {t("Measure")}
        </Button>
        <TextField size="small" fullWidth value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("Search")} slotProps={{ htmlInput: { "aria-label": t("Search measures") } }} />
      </Stack>
      <List dense sx={{ overflow: "auto", flex: 1, minHeight: 0, pt: 0 }} aria-label={t("Measures")}>
        {groups.length === 0 && <Typography sx={{ px: 2, py: 1, fontSize: 13, color: "text.secondary" }}>{searching ? t("No results") : t("None yet")}</Typography>}
        {groups.flatMap((g) => {
          const open = searching || !closed.has(g.name);
          return [
            <ListItem key={`h:${g.name}`} disablePadding>
              <ListItemButton aria-expanded={open} onClick={() => flip(g.name)} sx={{ gap: 0.5, pl: 1 }}>
                {open ? <ExpandMoreOutlined sx={{ fontSize: 18 }} /> : <ChevronRightOutlined sx={{ fontSize: 18 }} />}
                <Typography noWrap sx={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 650 }}>
                  {g.name}
                </Typography>
                <Typography sx={{ fontSize: 12, color: "text.secondary" }}>{g.measures.length}</Typography>
              </ListItemButton>
            </ListItem>,
            ...(open ? g.measures.map(row) : []),
          ];
        })}
      </List>
      <DeleteMeasureDialog name={deleting} usedBy={deleting ? actions.usedBy(deleting).map(label) : []} onConfirm={() => actions.remove(deleting!)} onClose={() => setDeleting(null)} />
    </Box>
  );
}
