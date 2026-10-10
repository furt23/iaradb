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

import { useGuard, useNotify } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { isIdentifier, MAIN_SCHEMA, suggestTableName } from "@/lib/catalogToml";
import { addTable, listSchemas } from "@/server/actions/catalog";

import { useData } from "./DataProvider";
import { tableHref } from "./links";

/**
 * Name a dataset in workhouse.toml, in a schema (main by default); the new
 * table opens in the Data section.
 */
export function AddTableDialog({
  open,
  onClose,
  initialPath,
  schema,
}: {
  open: boolean;
  onClose(): void;
  initialPath?: string;
  /** the schema to add to (default: main) */
  schema?: string;
}) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [format, setFormat] = useState<"auto" | "parquet" | "csv" | "json">("auto");
  const [named, setNamed] = useState(false);
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
    setTarget(schema ?? MAIN_SCHEMA);
    void listSchemas().then((r) => {
      if (r.ok) setSchemas(r.data.map((s) => s.name));
    });
  }, [open, initialPath, schema]);

  const submit = () =>
    guard(async () => {
      const qualified = target === MAIN_SCHEMA ? name : `${target}.${name}`;
      const ref = unwrap(await addTable(qualified, path, format === "auto" ? undefined : format));
      notify(`Added ${ref.name} to workhouse.toml`, "success");
      invalidate();
      onClose();
      router.push(tableHref(ref.name));
      router.refresh();
    });

  const badName = name !== "" && !isIdentifier(name);
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Add a table</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="Path"
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              // the name follows the path until it is edited
              if (!named) setName(suggestTableName(e.target.value));
            }}
            autoFocus={!initialPath}
            helperText="Relative to the workspace, or an s3:// URL: a file, a directory or a glob (data/events/*.parquet)"
          />
          <Stack direction="row" spacing={2}>
            <TextField
              label="Name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNamed(true);
              }}
              autoFocus={Boolean(initialPath)}
              error={badName}
              helperText={badName ? "Letters, digits and underscores" : "How queries refer to it"}
              sx={{ flex: 1 }}
            />
            <TextField select label="Schema" value={target} onChange={(e) => setTarget(e.target.value)} sx={{ minWidth: 160 }}>
              {(schemas.includes(target) ? schemas : [...schemas, target]).map((s) => (
                <MenuItem key={s} value={s}>
                  {s}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
          <TextField select label="Format" value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
            <MenuItem value="auto">From the extension</MenuItem>
            <MenuItem value="parquet">Parquet</MenuItem>
            <MenuItem value="csv">CSV</MenuItem>
            <MenuItem value="json">JSON</MenuItem>
          </TextField>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={submit} disabled={!name || !path || badName}>
          Add
        </Button>
      </DialogActions>
    </Dialog>
  );
}
