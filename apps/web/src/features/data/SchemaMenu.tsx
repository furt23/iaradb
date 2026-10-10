"use client";

import Add from "@mui/icons-material/Add";
import DeleteOutline from "@mui/icons-material/DeleteOutlineOutlined";
import Divider from "@mui/material/Divider";
import Menu from "@mui/material/Menu";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useGuard, useNotify } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { removeSchema } from "@/server/actions/catalog";

import { ActionItem } from "./ActionItem";
import { AddTableDialog } from "./AddTableDialog";
import type { MenuAnchor } from "./TreeRow";

export interface SchemaMenuTarget {
  schema: string;
  /** how many tables the schema has */
  tables: number;
  anchor: MenuAnchor;
}

/** Actions on a schema: add a table to it, or remove it when it is empty. */
export function SchemaMenu({ target, onClose }: { target: SchemaMenuTarget | null; onClose(): void }) {
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const guard = useGuard();
  const notify = useNotify();
  const router = useRouter();
  const anchor = target?.anchor;
  const point = anchor && "x" in anchor ? anchor : null;
  const run = (fn: (t: SchemaMenuTarget) => void | Promise<void>) => () => {
    if (!target) return;
    onClose();
    void fn(target);
  };
  const remove = (t: SchemaMenuTarget) =>
    guard(async () => {
      unwrap(await removeSchema(t.schema));
      notify(`Removed schema ${t.schema}`, "success");
      router.refresh();
    });
  return (
    <>
      <Menu
        open={target !== null}
        onClose={onClose}
        anchorEl={anchor && !point ? (anchor as HTMLElement) : null}
        anchorReference={point ? "anchorPosition" : "anchorEl"}
        anchorPosition={point ? { top: point.y, left: point.x } : undefined}
        slotProps={{ list: { dense: true, "aria-label": target ? `actions for schema ${target.schema}` : undefined } }}
      >
        <ActionItem icon={<Add fontSize="small" />} label="Add table here…" onClick={run((t) => setAddingTo(t.schema))} />
        <Divider />
        <ActionItem icon={<DeleteOutline fontSize="small" />} label="Remove schema" onClick={run(remove)} danger disabled={!!target && target.tables > 0} />
      </Menu>
      <AddTableDialog open={addingTo !== null} schema={addingTo ?? undefined} onClose={() => setAddingTo(null)} />
    </>
  );
}
