"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useState, type MouseEvent } from "react";

import { MAIN_SCHEMA, type CatalogTable } from "@/lib/catalogToml";

import { CatalogMenu, type CatalogMenuTarget } from "./CatalogMenu";
import { CatalogRow } from "./CatalogRow";
import { ColumnList } from "./ColumnList";
import { useData } from "./DataProvider";
import type { CatalogGroup, SchemaGroup } from "./schemaGroups";
import { SchemaMenu, type SchemaMenuTarget } from "./SchemaMenu";
import { SchemaRow } from "./SchemaRow";
import { TableMenu, type TableMenuTarget } from "./TableMenu";
import { TableRow } from "./TableRow";
import type { MenuAnchor } from "./TreeRow";

/** The indents (spacing units) of a schema under its catalog, and of a table under its schema (its columns too). */
const SCHEMA_INDENT = 2;
const TABLE_INDENT = 4;

/** Stops a click on a row's menu from also toggling the row. */
function openMenu(e: MouseEvent<HTMLElement>, open: (anchor: MenuAnchor) => void, anchor: MenuAnchor) {
  e.preventDefault();
  e.stopPropagation();
  open(anchor);
}

/** A schema's key in the tree: its catalog and its name (identifiers have no dots, so the key is unique). */
const keyOf = (g: SchemaGroup) => `${g.catalog}.${g.schema}`;

/**
 * The catalog as a tree: each catalog (the default first) opens to its schemas, the
 * default one and the catalog of the open table open too; `main` opens in each
 * catalog, and the schema of the open table opens too, the others stay closed until
 * clicked. Each table expands to its columns and has a "…" menu.
 */
export function CatalogTree({ groups, active }: { groups: CatalogGroup[]; active: string | null }) {
  const { columns, loadColumns } = useData();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [catalogOpen, setCatalogOpen] = useState<Record<string, boolean | undefined>>({});
  const [schemaOpen, setSchemaOpen] = useState<Record<string, boolean | undefined>>({});
  const [menu, setMenu] = useState<TableMenuTarget | null>(null);
  const [schemaMenu, setSchemaMenu] = useState<SchemaMenuTarget | null>(null);
  const [catalogMenu, setCatalogMenu] = useState<CatalogMenuTarget | null>(null);

  const activeCatalog = groups.find((c) => c.schemas.some((s) => s.tables.some((t) => t.name === active)))?.name;
  const activeSchema = groups.flatMap((c) => c.schemas).find((s) => s.tables.some((t) => t.name === active));
  const activeKey = activeSchema ? keyOf(activeSchema) : null;
  const isCatalogOpen = (c: CatalogGroup) => catalogOpen[c.name] ?? (c.isDefault || c.name === activeCatalog);
  const toggleCatalog = (c: CatalogGroup) => setCatalogOpen((s) => ({ ...s, [c.name]: !isCatalogOpen(c) }));
  const isSchemaOpen = (g: SchemaGroup) => schemaOpen[keyOf(g)] ?? (g.schema === MAIN_SCHEMA || keyOf(g) === activeKey);
  const toggleSchema = (g: SchemaGroup) => setSchemaOpen((s) => ({ ...s, [keyOf(g)]: !isSchemaOpen(g) }));
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
      {groups.map((c) => {
        const expanded = isCatalogOpen(c);
        return (
          <Box key={c.name} role="listitem">
            <CatalogRow
              catalog={c}
              open={expanded}
              onToggle={() => toggleCatalog(c)}
              onMenu={(e, anchor) => openMenu(e, (a) => setCatalogMenu({ catalog: c, anchor: a }), anchor)}
            />
            {expanded && (
              <Box role="list" aria-label={`schemas of ${c.name}`}>
                {c.schemas.map((g) => {
                  const schemaExpanded = isSchemaOpen(g);
                  return (
                    <Box key={keyOf(g)} role="listitem">
                      <SchemaRow
                        group={g}
                        indent={SCHEMA_INDENT}
                        open={schemaExpanded}
                        onToggle={() => toggleSchema(g)}
                        onMenu={(e, anchor) => openMenu(e, (a) => setSchemaMenu({ group: g, anchor: a }), anchor)}
                      />
                      {schemaExpanded && g.discoveryError && (
                        <Typography sx={{ pl: 4 + TABLE_INDENT, pr: 1, py: 0.25, fontSize: 12, color: "error.main" }}>{g.discoveryError}</Typography>
                      )}
                      {schemaExpanded && g.tables.length === 0 && !g.discoveryError && (
                        <Typography sx={{ pl: 4 + TABLE_INDENT, py: 0.25, fontSize: 12, color: "text.disabled" }}>No tables yet</Typography>
                      )}
                      {schemaExpanded && g.tables.length > 0 && (
                        <Box role="list" aria-label={`tables of ${g.name}`}>
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
              </Box>
            )}
          </Box>
        );
      })}
      <TableMenu target={menu} onClose={() => setMenu(null)} />
      <SchemaMenu target={schemaMenu} onClose={() => setSchemaMenu(null)} />
      <CatalogMenu target={catalogMenu} onClose={() => setCatalogMenu(null)} />
    </Box>
  );
}
