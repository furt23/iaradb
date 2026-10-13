"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useState, type MouseEvent } from "react";

import { MAIN_SCHEMA, type CatalogTable } from "@/lib/catalogToml";

import { ColumnList } from "./ColumnList";
import { useData } from "./DataProvider";
import { type SchemaGroup } from "./schemaGroups";
import { SchemaMenu, type SchemaMenuTarget } from "./SchemaMenu";
import { SchemaRow } from "./SchemaRow";
import { TableMenu, type TableMenuTarget } from "./TableMenu";
import { TableRow } from "./TableRow";
import type { MenuAnchor } from "./TreeRow";

/** The tables under a schema, and the columns under a table, indented (spacing units). */
const TABLE_INDENT = 2;

/** Stops a click on a row's menu from also toggling the row. */
function openMenu(e: MouseEvent<HTMLElement>, open: (anchor: MenuAnchor) => void, anchor: MenuAnchor) {
  e.preventDefault();
  e.stopPropagation();
  open(anchor);
}

/**
 * The catalog by schema: `main` first and open, the schema of the open table
 * opens too, the others stay closed until clicked. Each table expands to its
 * columns and has a "…" menu.
 */
export function CatalogTree({ groups, active }: { groups: SchemaGroup[]; active: string | null }) {
  const { columns, loadColumns } = useData();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [schemaOpen, setSchemaOpen] = useState<Record<string, boolean | undefined>>({});
  const [menu, setMenu] = useState<TableMenuTarget | null>(null);
  const [schemaMenu, setSchemaMenu] = useState<SchemaMenuTarget | null>(null);

  const activeSchema = groups.find((g) => g.tables.some((t) => t.name === active))?.schema;
  const isOpen = (schema: string) => schemaOpen[schema] ?? (schema === MAIN_SCHEMA || schema === activeSchema);
  const toggleSchema = (schema: string) => setSchemaOpen((s) => ({ ...s, [schema]: !isOpen(schema) }));
  const toggleColumns = (table: CatalogTable) => {
    loadColumns();
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(table.name)) next.add(table.name);
      return next;
    });
  };

  return (
    <Box role="list" aria-label="catalog tables">
      {groups.map((g) => {
        const expanded = isOpen(g.schema);
        return (
          <Box key={g.schema} role="listitem">
            <SchemaRow
              group={g}
              open={expanded}
              onToggle={() => toggleSchema(g.schema)}
              onMenu={(e, anchor) => openMenu(e, (a) => setSchemaMenu({ schema: g.schema, tables: g.tables.length, anchor: a }), anchor)}
            />
            {expanded && g.discoveryError && (
              <Typography sx={{ pl: 4 + TABLE_INDENT, pr: 1, py: 0.25, fontSize: 12, color: "error.main" }}>{g.discoveryError}</Typography>
            )}
            {expanded && g.tables.length === 0 && !g.discoveryError && (
              <Typography sx={{ pl: 4 + TABLE_INDENT, py: 0.25, fontSize: 12, color: "text.disabled" }}>No tables yet</Typography>
            )}
            {expanded && g.tables.length > 0 && (
              <Box role="list" aria-label={`tables of ${g.schema}`}>
                {g.tables.map((t) => (
                  <Box key={t.name} role="listitem">
                    <TableRow
                      table={t}
                      active={t.name === active}
                      indent={TABLE_INDENT}
                      open={open.has(t.name)}
                      onToggle={() => toggleColumns(t)}
                      onMenu={(e, anchor) => openMenu(e, (a) => setMenu({ table: t, anchor: a }), anchor)}
                    />
                    {open.has(t.name) && <ColumnList name={t.name} indent={TABLE_INDENT} columns={columns} />}
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        );
      })}
      <TableMenu target={menu} onClose={() => setMenu(null)} />
      <SchemaMenu target={schemaMenu} onClose={() => setSchemaMenu(null)} />
    </Box>
  );
}
