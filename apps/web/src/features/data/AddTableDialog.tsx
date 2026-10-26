"use client";

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useGuard, useNotify } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { type CatalogInfo, isIdentifier, MAIN_SCHEMA, suggestTableName } from "@/lib/catalogToml";
import { addTable, listCatalogs, listSchemas } from "@/server/actions/catalog";

import { useData } from "./DataProvider";
import { tableHref } from "./links";

/**
 * Name a dataset in the catalog: in a catalog and a schema (the default catalog's main
 * by default); the new table opens in the Data section.
 */
export function AddTableDialog({
  open,
  onClose,
  initialPath,
  catalog,
  schema,
}: {
  open: boolean;
  onClose(): void;
  initialPath?: string;
  /** the catalog to add to (default: the default catalog) */
  catalog?: string;
  /** the schema to add to (default: main) */
  schema?: string;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [format, setFormat] = useState<"auto" | "parquet" | "csv" | "json">("auto");
  const [named, setNamed] = useState(false);
  const [chosen, setChosen] = useState("");
  const [catalogs, setCatalogs] = useState<CatalogInfo[]>([]);
  const [target, setTarget] = useState(MAIN_SCHEMA);
  const [schemas, setSchemas] = useState<string[]>([MAIN_SCHEMA]);
  const { invalidate } = useData();
  const guard = useGuard();
  const notify = useNotify();
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    setPath(initialPath ?? "");
    setName(initialPath ? suggestTableName(initialPath) : "");
    setNamed(false);
    setFormat("auto");
    setChosen(catalog ?? "");
    setTarget(schema ?? MAIN_SCHEMA);
    void listCatalogs().then((r) => {
      if (!r.ok) return;
      setCatalogs(r.data);
      setChosen((c) => c || r.data[0]?.name || "");
    });
  }, [open, initialPath, catalog, schema]);

  useEffect(() => {
    if (!open || !chosen) return;
    void listSchemas(chosen).then((r) => {
      if (r.ok) setSchemas(r.data.map((s) => s.name));
    });
  }, [open, chosen]);

  // another catalog has its own schemas: main is the one to add to
  const pickCatalog = (catalogName: string) => {
    setChosen(catalogName);
    setTarget(MAIN_SCHEMA);
  };

  const submit = () =>
    guard(async () => {
      const qualified = target === MAIN_SCHEMA ? name : `${target}.${name}`;
      const ref = unwrap(await addTable(qualified, path, format === "auto" ? undefined : format, chosen));
      notify(`Added ${ref.name} to the catalog`, "success");
      invalidate();
      onClose();
      router.push(tableHref(ref.name));
      router.refresh();
    });

  const badName = name !== "" && !isIdentifier(name);
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t("Add a table")}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label={t("Path")}
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              // the name follows the path until it is edited
              if (!named) setName(suggestTableName(e.target.value));
            }}
            autoFocus={!initialPath}
            helperText={t("Relative to the workspace, or an s3:// URL: a file, a directory or a glob (data/events/*.parquet)")}
          />
          <Stack direction="row" spacing={2}>
            <TextField
              label={t("Name")}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNamed(true);
              }}
              autoFocus={Boolean(initialPath)}
              error={badName}
              helperText={badName ? t("Letters, digits and underscores") : undefined}
              sx={{ flex: 1 }}
            />
            <TextField select label={t("Catalog")} value={chosen} onChange={(e) => pickCatalog(e.target.value)} sx={{ minWidth: 150 }}>
              {catalogs.map((c) => (
                <MenuItem key={c.name} value={c.name}>
                  {c.isDefault ? `${c.name} (${t("default")})` : c.name}
                </MenuItem>
              ))}
            </TextField>
            <TextField select label={t("Schema")} value={target} onChange={(e) => setTarget(e.target.value)} sx={{ minWidth: 150 }}>
              {(schemas.includes(target) ? schemas : [...schemas, target]).map((s) => (
                <MenuItem key={s} value={s}>
                  {s}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
          <TextField select label={t("Format")} value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
            <MenuItem value="auto">{t("From the extension")}</MenuItem>
            <MenuItem value="parquet">Parquet</MenuItem>
            <MenuItem value="csv">CSV</MenuItem>
            <MenuItem value="json">JSON</MenuItem>
          </TextField>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("Cancel")}</Button>
        <Button variant="contained" onClick={submit} disabled={!name || !path || badName || !chosen}>
          {t("Add")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
