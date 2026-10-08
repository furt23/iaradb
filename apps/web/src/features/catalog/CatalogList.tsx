"use client";

import Add from "@mui/icons-material/Add";
import Refresh from "@mui/icons-material/Refresh";
import TableChartOutlined from "@mui/icons-material/TableChartOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import type { TableRef } from "@workhouse/protocol";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { PageBody, PageHeader } from "@/features/shell/PageHeader";
import { useGuard } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { reloadCatalog } from "@/server/actions/catalog";

import { AddTableDialog } from "./AddTableDialog";

export function CatalogList({ tables, error }: { tables: TableRef[]; error: string | null }) {
  const [adding, setAdding] = useState(false);
  const router = useRouter();
  const guard = useGuard();
  const reload = () => guard(async () => (unwrap(await reloadCatalog()), router.refresh()));
  return (
    <>
      <PageHeader
        title="Catalog"
        subtitle="Named datasets from workhouse.toml, queryable from every notebook and the SQL editor"
        actions={
          <>
            <Button startIcon={<Refresh />} onClick={reload} sx={{ color: "text.secondary" }}>
              Reload
            </Button>
            <Button variant="contained" color="secondary" startIcon={<Add />} onClick={() => setAdding(true)}>
              Add table
            </Button>
          </>
        }
      />
      <PageBody>
        {error && <Typography sx={{ color: "error.main", mb: 2 }}>{error}</Typography>}
        <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 2 }}>
          {tables.map((t) => (
            <Paper
              key={t.name}
              variant="outlined"
              component={Link}
              href={`/catalog/${t.name}`}
              sx={{ p: 2, textDecoration: "none", display: "flex", gap: 1.5, alignItems: "flex-start", "&:hover": { borderColor: "secondary.main" } }}
            >
              <TableChartOutlined sx={{ color: "primary.main", mt: 0.25 }} />
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontWeight: 650 }}>{t.name}</Typography>
                <Typography variant="mono" noWrap component="div" sx={{ color: "text.secondary", fontSize: 11.5 }}>
                  {t.format} · {t.path}
                </Typography>
              </Box>
            </Paper>
          ))}
        </Box>
        {tables.length === 0 && !error && (
          <Typography sx={{ color: "text.secondary" }}>No tables yet. Add a Parquet or CSV dataset to start querying it by name.</Typography>
        )}
      </PageBody>
      <AddTableDialog open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
