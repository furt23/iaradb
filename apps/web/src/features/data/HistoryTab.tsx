"use client";

import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import type { DeltaCommit, RunStreamEvent } from "@iara/protocol";
import { useCallback, useEffect, useState } from "react";

import { useNotify } from "@/features/shell/notify";
import { restoreStatement } from "@/lib/deltaHistory";
import { streamEvents } from "@/lib/sse";
import { tableHistory } from "@/server/actions/catalog";

import { useData, type Load } from "./DataProvider";
import { HistoryRow } from "./HistoryRow";
import { LoadFailure } from "./LoadFailure";
import { RestoreDialog } from "./RestoreDialog";

/** Run one statement on the workspace kernel; throws the engine's error. */
async function runStatement(query: string): Promise<void> {
  let failure: string | null = null;
  await streamEvents("/api/run", { kind: "sql", query }, (e) => {
    const ev = e as RunStreamEvent;
    if (ev.event === "failed") failure = ev.data.message;
  });
  if (failure) throw new Error(failure);
}

/** The commits of a Delta table, with querying and restoring of a version. */
export function HistoryTab({ name, version }: { name: string; version: number | null | undefined }) {
  const { load } = useData();
  const notify = useNotify();
  const [state, setState] = useState<Load<DeltaCommit[]>>({ status: "loading" });
  const [restoring, setRestoring] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const r = await tableHistory(name);
    setState(r.ok ? { status: "ready", data: r.data } : { status: "failed", type: r.error.type, message: r.error.message });
  }, [name]);

  useEffect(() => {
    setState({ status: "loading" });
    void refresh();
  }, [refresh]);

  const restore = async (v: number) => {
    await runStatement(restoreStatement(name, v));
    notify(`Restored ${name} to version ${v}`, "success");
    load(name, true);
    await refresh();
  };

  if (state.status === "loading") return null;
  if (state.status === "failed") return <LoadFailure type={state.type} message={state.message} onRetry={() => void refresh()} />;
  const newest = state.data[0]?.version ?? version;
  return (
    <>
      <Table size="small" stickyHeader aria-label={`history of ${name}`}>
        <TableHead>
          <TableRow>
            <TableCell sx={{ width: 40 }} />
            <TableCell>Version</TableCell>
            <TableCell>Time</TableCell>
            <TableCell>Operation</TableCell>
            <TableCell>Changes</TableCell>
            <TableCell />
          </TableRow>
        </TableHead>
        <TableBody>
          {state.data.map((c) => (
            <HistoryRow key={c.version} commit={c} table={name} current={c.version === newest} onRestore={setRestoring} />
          ))}
        </TableBody>
      </Table>
      <RestoreDialog table={name} version={restoring} onRestore={restore} onClose={() => setRestoring(null)} />
    </>
  );
}
