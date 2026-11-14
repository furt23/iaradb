"use client";

import TableChartOutlined from "@mui/icons-material/TableChartOutlined";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useEffect, useRef, useState } from "react";

import { useNotify } from "@/features/shell/notify";
import { useTranslation } from "@/i18n";
import { MAX_TABLES } from "@/lib/agents/check";
import type { AgentTable } from "@/lib/agents/types";
import { agentTableInfoAction, readableTablesAction } from "@/server/actions/agents";

import { TableDetail, type TableInfo } from "./TableDetail";
import { TableTreePane } from "./TableTreePane";

/** The tables the agent may read: a tree to include them by catalog and schema, and the selected one's detail. */
export function TablesTab({ tables, onChange }: { tables: AgentTable[]; onChange(t: AgentTable[]): void }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const [readable, setReadable] = useState<string[] | null>(null);
  const [infos, setInfos] = useState<Record<string, TableInfo>>({});
  const [picked, setPicked] = useState<string | null>(null);
  const requested = useRef(new Set<string>());

  useEffect(() => {
    void readableTablesAction().then((r) => {
      if (r.ok) setReadable(r.data);
      else {
        setReadable([]);
        notify(r.error.message, "error");
      }
    });
  }, [notify]);

  const selected = picked ?? tables.find((x) => x.included)?.name ?? null;

  useEffect(() => {
    if (!selected || requested.current.has(selected)) return;
    requested.current.add(selected);
    setInfos((prev) => ({ ...prev, [selected]: { status: "loading" } }));
    void agentTableInfoAction(selected).then((r) => {
      if (r.ok) setInfos((prev) => ({ ...prev, [selected]: { status: "ready", columns: r.data.columns, numRows: r.data.numRows } }));
      else {
        // a later selection of the table asks again
        requested.current.delete(selected);
        setInfos((prev) => ({ ...prev, [selected]: { status: "error", message: r.error.message } }));
      }
    });
  }, [selected]);

  const entryOf = (name: string): AgentTable => tables.find((x) => x.name === name) ?? { name, included: false, note: "", columns: {} };
  const save = (next: AgentTable) => {
    const exists = tables.some((x) => x.name === next.name);
    onChange(exists ? tables.map((x) => (x.name === next.name ? next : x)) : [...tables, next]);
  };

  // one change for many tables, so a schema's check is a single save; entries left out keep their notes
  const setIncluded = (names: string[], included: boolean) => {
    const listed = new Set(tables.map((x) => x.name));
    const turned = new Set(names);
    const added = included
      ? names.filter((n) => !listed.has(n)).slice(0, Math.max(0, MAX_TABLES - tables.length))
      : [];
    const next = [
      ...tables.map((x) => (turned.has(x.name) && x.included !== included ? { ...x, included } : x)),
      ...added.map((name) => ({ name, included: true, note: "", columns: {} })),
    ];
    if (next.length === tables.length && next.every((x, i) => x === tables[i])) return;
    onChange(next);
  };

  return (
    <Box sx={{ display: "flex", height: "100%", minHeight: 0 }}>
      <Box sx={{ width: 260, flexShrink: 0, minHeight: 0, display: "flex", flexDirection: "column", borderRight: 1, borderColor: "divider", bgcolor: "background.paper" }}>
        <TableTreePane tables={tables} readable={readable} infos={infos} selected={selected} onSelect={setPicked} onIncluded={setIncluded} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {selected ? (
          <TableDetail table={entryOf(selected)} info={infos[selected]} onChange={save} onIncluded={(on) => setIncluded([selected], on)} />
        ) : (
          <Box sx={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1, color: "text.disabled" }}>
            <TableChartOutlined sx={{ fontSize: 40 }} />
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {t("Pick a table")}
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
}
