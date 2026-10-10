"use client";

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import type { TableRef } from "@workhouse/protocol";
import { useRouter } from "next/navigation";

import { useGuard, useNotify } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { removeTable } from "@/server/actions/catalog";

import { useData } from "./DataProvider";

/** Remove a table from workhouse.toml (its data stays where it is). */
export function RemoveTableDialog({ table, onClose }: { table: TableRef | null; onClose(): void }) {
  const { act, invalidate } = useData();
  const guard = useGuard();
  const notify = useNotify();
  const router = useRouter();
  const remove = () =>
    guard(async () => {
      if (!table) return;
      unwrap(await removeTable(table.name));
      act({ type: "close", name: table.name });
      invalidate();
      notify(`Removed ${table.name} from the catalog`, "success");
      onClose();
      router.refresh();
    });
  return (
    <Dialog open={table !== null} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Remove {table?.name}?</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Its section is removed from workhouse.toml. The data at <b>{table?.path}</b> is not touched, but queries and notebooks that read{" "}
          <b>{table?.name}</b> will stop finding it.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button color="error" variant="contained" onClick={remove}>
          Remove
        </Button>
      </DialogActions>
    </Dialog>
  );
}
