"use client";

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import type { TableRef } from "@iara/protocol";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";

import { useGuard, useNotify } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { removeTable } from "@/server/actions/catalog";

import { useData } from "./DataProvider";

/** Remove a table from the catalog (its data stays where it is). */
export function RemoveTableDialog({ table, onClose }: { table: TableRef | null; onClose(): void }) {
  const { t } = useTranslation();
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
      <DialogTitle>{table ? t("Remove {{name}}?", { name: table.name }) : ""}</DialogTitle>
      <DialogContent>
        <DialogContentText>
          {table
            ? t("Its entry is removed from the catalog. The data at {{path}} is not touched, but queries and notebooks that read {{name}} will stop finding it.", {
                path: table.path,
                name: table.name,
              })
            : ""}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("Cancel")}</Button>
        <Button color="error" variant="contained" onClick={remove}>
          {t("Remove")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

