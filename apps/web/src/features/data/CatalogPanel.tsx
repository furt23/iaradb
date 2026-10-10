"use client";

import Add from "@mui/icons-material/Add";
import CreateNewFolderOutlined from "@mui/icons-material/CreateNewFolderOutlined";
import Refresh from "@mui/icons-material/Refresh";
import Search from "@mui/icons-material/Search";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useGuard } from "@/features/shell/notify";
import { SidePanelHeader } from "@/features/shell/SidePanelHeader";
import { unwrap } from "@/lib/action";
import type { CatalogSchema, CatalogTable } from "@/lib/catalogToml";
import { syncCatalog } from "@/server/actions/catalog";

import { AddTableDialog } from "./AddTableDialog";
import { CatalogTree } from "./CatalogTree";
import { useData } from "./DataProvider";
import { tableFromPathname } from "./links";
import { NewSchemaDialog } from "./NewSchemaDialog";
import { schemaGroups } from "./schemaGroups";

function matches(t: CatalogTable, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  return !f || t.name.toLowerCase().includes(f) || t.path.toLowerCase().includes(f);
}

/**
 * The Data side panel: the catalog's tables by schema, a filter, and adding
 * schemas, tables or reloading. `schemas` are the declared ones; the schemas
 * of the tables are shown in any case.
 */
export function CatalogPanel({ tables, schemas = [], error }: { tables: CatalogTable[]; schemas?: CatalogSchema[]; error: string | null }) {
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState("");
  const { act, invalidate } = useData();
  const guard = useGuard();
  const router = useRouter();
  const active = tableFromPathname(usePathname());
  const names = tables.map((t) => t.name).join("\n");

  // tables removed from workhouse.toml lose their tabs
  useEffect(() => {
    if (!error) act({ type: "keep", names: names ? names.split("\n") : [] });
  }, [names, error, act]);

  const reload = () =>
    guard(async () => {
      unwrap(await syncCatalog());
      invalidate();
      router.refresh();
    });

  const shown = tables.filter((t) => matches(t, filter));
  // while filtering, a schema without a matching table is hidden
  const groups = schemaGroups(schemas, shown).filter((g) => !filter.trim() || g.tables.length > 0);
  return (
    <>
      <SidePanelHeader
        overline="Data"
        title="Catalog"
        actions={
          <>
            <Tooltip title="Add a table">
              <IconButton onClick={() => setAdding(true)} aria-label="add table">
                <Add fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="New schema…">
              <IconButton onClick={() => setCreating(true)} aria-label="new schema">
                <CreateNewFolderOutlined fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Reload workhouse.toml">
              <IconButton onClick={reload} aria-label="reload catalog">
                <Refresh fontSize="small" />
              </IconButton>
            </Tooltip>
          </>
        }
      />
      <Box sx={{ px: 1, py: 1, borderBottom: 1, borderColor: "divider" }}>
        <TextField
          size="small"
          fullWidth
          placeholder="Filter tables"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setFilter("")}
          slotProps={{
            htmlInput: { "aria-label": "filter tables" },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <Search sx={{ fontSize: 16 }} />
                </InputAdornment>
              ),
              sx: { fontSize: 13 },
            },
          }}
        />
      </Box>
      <Box sx={{ flex: 1, overflow: "auto", px: 0.5, py: 0.5 }}>
        {error && (
          <Typography variant="body2" sx={{ color: "error.main", p: 1.5 }}>
            {error}
          </Typography>
        )}
        <CatalogTree groups={groups} active={active} />
        {!error && tables.length > 0 && shown.length === 0 && (
          <Typography variant="body2" sx={{ color: "text.secondary", p: 1.5 }}>
            No table matches “{filter}”.
          </Typography>
        )}
        {!error && tables.length === 0 && (
          <Typography variant="body2" sx={{ color: "text.secondary", p: 1.5 }}>
            No tables yet: add a Parquet or CSV dataset to query it by name.
          </Typography>
        )}
      </Box>
      <AddTableDialog open={adding} onClose={() => setAdding(false)} />
      <NewSchemaDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
