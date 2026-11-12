"use client";

import CalendarMonthOutlined from "@mui/icons-material/CalendarMonthOutlined";
import ChevronRightOutlined from "@mui/icons-material/ChevronRightOutlined";
import ExpandMoreOutlined from "@mui/icons-material/ExpandMoreOutlined";
import TableChartOutlined from "@mui/icons-material/TableChartOutlined";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { Widget } from "@/lib/dashboards/types";
import { typeLabel } from "@/lib/format";
import type { Measure } from "@/lib/model/types";

import type { FieldRef } from "../canvas/fieldDrag";
import { fieldState } from "./fieldActions";
import type { FieldTarget } from "./FieldMenu";
import { FieldRow, MeasureMark, MoreButton, TypeMark, useMenuHandlers, type MenuAnchor } from "./FieldRow";
import { typeGlyph, type FieldNode, type FieldTree } from "./fieldTree";

const LIST = { listStyle: "none", m: 0, p: 0 } as const;
const HEADING = { fontSize: 12, fontWeight: 650, color: "text.secondary", px: 1, pt: 1.5, pb: 0.5 } as const;

const measureField = (m: Measure): FieldRef => ({ kind: "measure", dataset: m.datasets[0] ?? "", name: m.name });

/** A dataset's or calendar's line: it opens and closes; a dataset also has a menu. */
function NodeHeader({ node, open, onToggle, onMenu }: { node: FieldNode; open: boolean; onToggle(): void; onMenu?(anchor: MenuAnchor): void }) {
  const menu = useMenuHandlers(onMenu);
  return (
    <Box {...menu} sx={{ display: "flex", alignItems: "center", pr: 0.5, borderRadius: 1, "&:hover": { bgcolor: "action.hover" } }}>
      <ButtonBase onClick={onToggle} aria-expanded={open} sx={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", justifyContent: "flex-start", gap: 0.5, py: 0.5, pl: 0.5, borderRadius: 1 }}>
        {open ? <ExpandMoreOutlined sx={{ fontSize: 18 }} /> : <ChevronRightOutlined sx={{ fontSize: 18 }} />}
        {node.kind === "calendar" ? <CalendarMonthOutlined sx={{ fontSize: 16, color: "text.secondary" }} /> : <TableChartOutlined sx={{ fontSize: 16, color: "text.secondary" }} />}
        <Typography noWrap sx={{ fontSize: 13, fontWeight: 600, minWidth: 0 }}>
          {node.name}
        </Typography>
      </ButtonBase>
      {onMenu && <MoreButton label={node.name} onMenu={onMenu} />}
    </Box>
  );
}

/**
 * The Fields pane's tree: each dataset (its columns, then its measures), each calendar, the measures that read
 * no dataset, and the model's parameters. `widget`: the selected one, whose checkboxes the rows show.
 * `selectedMeasure`: the one being edited; a click on a measure's name picks it (`onSelectMeasure`).
 */
export function FieldTreeView({
  tree,
  widget,
  isOpen,
  onToggle,
  onActivate,
  onMenu,
  selectedMeasure,
  onSelectMeasure,
}: {
  selectedMeasure?: string;
  onSelectMeasure?(name: string): void;
  tree: FieldTree;
  widget: Widget | undefined;
  isOpen(node: FieldNode): boolean;
  onToggle(node: FieldNode): void;
  onActivate(field: FieldRef): void;
  onMenu(target: FieldTarget, anchor: MenuAnchor): void;
}) {
  const { t } = useTranslation();

  const measureRow = (m: Measure) => {
    const field = measureField(m);
    return <FieldRow key={m.name} name={m.name} mark={<MeasureMark title={t("Measure")} />} field={field} state={fieldState(widget, field)} onActivate={() => onActivate(field)} selected={m.name === selectedMeasure} onSelect={onSelectMeasure && (() => onSelectMeasure(m.name))} onMenu={(a) => onMenu({ kind: "measure", name: m.name }, a)} />;
  };

  const body = (node: FieldNode): ReactNode => {
    const { columns } = node;
    return (
      <>
        {columns === null && (
          <Typography component="li" sx={{ fontSize: 12, color: "text.secondary", pl: 3.5, py: 0.5 }}>
            {t("Loading")}
          </Typography>
        )}
        {typeof columns === "string" && (
          <Typography component="li" role="alert" sx={{ fontSize: 12, color: "error.main", pl: 3.5, py: 0.5, overflowWrap: "anywhere" }}>
            {t("Could not read the columns of {{name}}: {{error}}", { name: node.name, error: columns })}
          </Typography>
        )}
        {Array.isArray(columns) &&
          columns.map((c) => {
            // a calendar's columns (a year, a month) are for the axes: they never go on a chart as a value by themselves
            const field: FieldRef = { kind: "column", dataset: node.name, name: c.name, ...(node.kind === "dataset" && { type: c.type }) };
            return (
              <FieldRow
                key={c.name}
                name={c.name}
                mark={<TypeMark glyph={typeGlyph(c.type)} title={typeLabel(c.type)} />}
                field={field}
                state={fieldState(widget, field)}
                onActivate={() => onActivate(field)}
                // a calendar's columns are the model's: no measure is made of them
                onMenu={node.kind === "dataset" ? (a) => onMenu({ kind: "column", dataset: node.name, name: c.name, type: c.type }, a) : undefined}
              />
            );
          })}
        {node.measures.map(measureRow)}
      </>
    );
  };

  return (
    <Box component="ul" sx={{ ...LIST, px: 0.5, pb: 1 }}>
      {tree.nodes.map((node) => {
        const open = isOpen(node);
        return (
          <Box component="li" key={node.name}>
            <NodeHeader node={node} open={open} onToggle={() => onToggle(node)} onMenu={node.kind === "dataset" ? (a) => onMenu({ kind: "dataset", name: node.name }, a) : undefined} />
            {open && (
              <Box component="ul" aria-label={node.name} sx={LIST}>
                {body(node)}
              </Box>
            )}
          </Box>
        );
      })}
      {tree.loose.length > 0 && (
        <Box component="li">
          <Typography sx={HEADING}>{t("Measures")}</Typography>
          <Box component="ul" aria-label={t("Measures")} sx={LIST}>
            {tree.loose.map(measureRow)}
          </Box>
        </Box>
      )}
      {tree.params.length > 0 && (
        <Box component="li">
          <Typography sx={HEADING}>{t("Parameters")}</Typography>
          <Box component="ul" aria-label={t("Parameters")} sx={LIST}>
            {tree.params.map((p) => (
              <Box component="li" key={p.name} sx={{ display: "flex", gap: 1, pl: 2.5, py: 0.25, fontSize: 13, minWidth: 0 }}>
                <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.name}
                </Box>
                <Box component="span" sx={{ color: "text.secondary", fontFamily: "var(--font-mono, monospace)", fontSize: 12, flexShrink: 0 }}>
                  = {JSON.stringify(p.default)}
                </Box>
              </Box>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
}
