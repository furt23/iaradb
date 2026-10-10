"use client";

import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { useState } from "react";

import { useGuard } from "@/features/shell/notify";
import { fileHref } from "@/features/workbench/WorkbenchProvider";
import { unwrap } from "@/lib/action";
import { detachNotebook } from "@/server/actions/clusters";

/** The notebooks attached to a cluster, each one detachable. */
export function NotebooksTab({ notebooks, onChanged }: { notebooks: string[]; onChanged(): Promise<unknown> }) {
  const guard = useGuard();
  const [pending, setPending] = useState<string | null>(null);

  const detach = (path: string) =>
    void guard(async () => {
      setPending(path);
      try {
        unwrap(await detachNotebook(path));
        await onChanged();
      } finally {
        setPending(null);
      }
    });

  if (!notebooks.length) {
    return <Typography sx={{ color: "text.secondary" }}>No notebook is attached to this cluster. Pick it from a notebook&apos;s toolbar.</Typography>;
  }
  return (
    <>
      <Paper variant="outlined">
        <Table size="small" aria-label="attached notebooks">
          <TableHead>
            <TableRow>
              <TableCell>Notebook</TableCell>
              <TableCell align="right" />
            </TableRow>
          </TableHead>
          <TableBody>
            {notebooks.map((path) => (
              <TableRow key={path}>
                <TableCell sx={{ overflowWrap: "anywhere" }}>
                  <Link href={fileHref(path)}>{path}</Link>
                </TableCell>
                <TableCell align="right">
                  <Button size="small" color="error" disabled={pending === path} onClick={() => detach(path)} aria-label={`detach ${path}`}>
                    Detach
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
      <Typography variant="caption" sx={{ display: "block", mt: 1, color: "text.disabled" }}>
        A detached notebook runs on the default cluster the next time it runs.
      </Typography>
    </>
  );
}
