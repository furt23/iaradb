"use client";

import Add from "@mui/icons-material/Add";
import StorageOutlined from "@mui/icons-material/StorageOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import type { TableRef } from "@iara/protocol";
import { useEffect, useState } from "react";

import { AddTableDialog } from "./AddTableDialog";
import { DataTabStrip } from "./DataTabStrip";
import { useData } from "./DataProvider";
import { LoadFailure } from "./LoadFailure";
import { TableView } from "./TableView";

function Start({ count }: { count: number }) {
  const [adding, setAdding] = useState(false);
  return (
    <Box sx={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", p: 3 }}>
      <Box sx={{ maxWidth: 420, textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
        <StorageOutlined sx={{ fontSize: 40, color: "text.disabled" }} />
        <Typography variant="h4">{count ? "Pick a table from the catalog" : "The catalog is empty"}</Typography>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {count
            ? `${count} tables in iara.toml. Each opens in a tab here, with its columns, statistics and a sample of its rows.`
            : "Name a Parquet or CSV dataset (a file, a folder, a glob or an s3:// URL) to query it from every notebook and the SQL editor."}
        </Typography>
        <Button startIcon={<Add />} onClick={() => setAdding(true)} sx={{ mt: 1 }}>
          Add table
        </Button>
      </Box>
      <AddTableDialog open={adding} onClose={() => setAdding(false)} />
    </Box>
  );
}

/** The Data pages: open tables in tabs, the URL names the one shown. */
export function DataView({ name, tables }: { name: string | null; tables: TableRef[] }) {
  const { tabs, follow, showActive } = useData();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (name) follow(name);
    else showActive();
  }, [name, follow, showActive]);

  // tabs are restored from the browser's storage: nothing to show before mount
  if (!mounted) return null;
  const shown = name ?? tabs.active;
  const table = shown ? tables.find((t) => t.name === shown) : undefined;
  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <DataTabStrip />
      {table ? (
        <TableView key={table.name} table={table} />
      ) : shown ? (
        <LoadFailure type="NotFound" message={`There is no table ${shown} in iara.toml.`} />
      ) : (
        <Start count={tables.length} />
      )}
    </Box>
  );
}
