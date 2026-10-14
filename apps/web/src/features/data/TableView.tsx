"use client";

import ContentCopyOutlined from "@mui/icons-material/ContentCopyOutlined";
import Refresh from "@mui/icons-material/Refresh";
import TableChartOutlined from "@mui/icons-material/TableChartOutlined";
import TerminalOutlined from "@mui/icons-material/TerminalOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Skeleton from "@mui/material/Skeleton";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { TableRef } from "@workhouse/protocol";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { OutputView } from "@/features/results/OutputView";
import { useNotify } from "@/features/shell/notify";
import { formatBytes, formatCount } from "@/lib/format";
import { useElementHeight } from "@/lib/useElementHeight";
import { WranglerView } from "@/features/wrangler";

import { HistoryTab } from "./HistoryTab";
import { ColumnsTable } from "./ColumnsTable";
import { useData, type Load } from "./DataProvider";
import { sampleQuery, sqlHref } from "./links";
import { LoadFailure } from "./LoadFailure";

function Stat({ label, value }: { label: string; value: string | null }) {
  return (
    <Box sx={{ minWidth: 72 }}>
      <Typography variant="overline" sx={{ color: "text.disabled", fontSize: 10, lineHeight: 1.6, display: "block" }}>
        {label}
      </Typography>
      {value === null ? <Skeleton width={56} height={26} /> : <Typography sx={{ fontWeight: 700, fontSize: 18, lineHeight: 1.4 }}>{value}</Typography>}
    </Box>
  );
}

function Loaded<T>({ load, onRetry, children }: { load: Load<T> | undefined; onRetry(): void; children(data: T): ReactNode }) {
  if (!load || load.status === "loading") {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
        <CircularProgress size={22} />
      </Box>
    );
  }
  if (load.status === "failed") return <LoadFailure type={load.type} message={load.message} onRetry={onRetry} />;
  return <>{children(load.data)}</>;
}

type Section = "columns" | "sample" | "history" | "wrangle";
/** the section each table showed last (tabs remount as they are switched) */
const lastSection = new Map<string, Section>();

/** A catalog table: where it lives, its size, columns with statistics, and a sample of its rows. */
export function TableView({ table }: { table: TableRef }) {
  const data = useData();
  const notify = useNotify();
  const { name } = table;
  const [section, setSection] = useState<Section>(() => lastSection.get(name) ?? "columns");
  const isDelta = table.format === "delta";
  const info = data.info(name);
  const ready = info?.status === "ready" ? info.data : null;
  const failed = info?.status === "failed";
  const stat = (f: (i: NonNullable<typeof ready>) => string) => (ready ? f(ready) : failed ? "–" : null);
  const { load } = data;
  const body = useRef<HTMLDivElement>(null);
  // the sample fills the tab (less its own toolbar and pager)
  const sampleHeight = Math.max(240, useElementHeight(body) - 100);

  useEffect(() => load(name), [name, load]);

  const copy = async () => {
    await navigator.clipboard.writeText(name);
    notify(`Copied ${name}`, "success");
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <Box sx={{ px: 3, pt: 2, pb: 1.5, display: "flex", gap: 2, alignItems: "flex-start", borderBottom: 1, borderColor: "divider" }}>
        <TableChartOutlined sx={{ color: "primary.main", mt: 0.5 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
            <Typography variant="h3" noWrap>
              {name}
            </Typography>
            <Chip label={isDelta ? "Delta" : table.format} size="small" variant="outlined" />
            {isDelta && typeof ready?.version === "number" && <Chip label={`v${ready.version}`} size="small" color="primary" variant="outlined" />}
          </Box>
          <Typography variant="mono" noWrap component="div" title={table.path} sx={{ color: "text.secondary", fontSize: 12 }}>
            {table.path}
          </Typography>
          {isDelta && ready?.partitions && ready.partitions.length > 0 && (
            <Typography variant="caption" component="div" sx={{ color: "text.secondary", mt: 0.5 }}>
              Partitioned by {ready.partitions.join(", ")}
            </Typography>
          )}
          <Box sx={{ display: "flex", gap: 4, mt: 1.5 }}>
            <Stat label="Rows" value={stat((i) => formatCount(i.num_rows))} />
            <Stat label="Columns" value={stat((i) => String(i.columns.length))} />
            <Stat label="Files" value={stat((i) => formatCount(i.files))} />
            <Stat label="Size" value={stat((i) => formatBytes(i.bytes))} />
          </Box>
        </Box>
        <Box sx={{ display: "flex", gap: 0.5, alignItems: "center" }}>
          <Tooltip title="Copy the table name">
            <IconButton aria-label="copy table name" onClick={() => void copy()}>
              <ContentCopyOutlined fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Reload statistics and sample">
            <IconButton aria-label="reload table" onClick={() => load(name, true)}>
              <Refresh fontSize="small" />
            </IconButton>
          </Tooltip>
          <Button variant="outlined" startIcon={<TerminalOutlined />} component={Link} href={sqlHref(sampleQuery(name))}>
            Query
          </Button>
        </Box>
      </Box>
      <Tabs
        value={section}
        onChange={(_, v: Section) => {
          lastSection.set(name, v);
          setSection(v);
        }} sx={{ px: 2, minHeight: 38, borderBottom: 1, borderColor: "divider", "& .MuiTab-root": { minHeight: 38, py: 0, fontSize: 13 } }}>
        <Tab value="columns" label={ready ? `Columns (${ready.columns.length})` : "Columns"} />
        <Tab value="sample" label="Sample data" />
        <Tab value="wrangle" label="Wrangle" />
        {isDelta && <Tab value="history" label="History" />}
      </Tabs>
      <Box ref={body} sx={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {section === "columns" ? (
          <Loaded load={info} onRetry={() => load(name, true)}>
            {(i) => <ColumnsTable info={i} />}
          </Loaded>
        ) : section === "history" && isDelta ? (
          <HistoryTab name={name} version={ready?.version} />
        ) : section === "wrangle" ? (
          <WranglerView kernelKey="workspace" source={{ table: name }} label={name} />
        ) : (
          <Loaded load={data.preview(name)} onRetry={() => load(name, true)}>
            {(output) => <OutputView output={output} kernelKey="workspace" tableHeight={sampleHeight} />}
          </Loaded>
        )}
      </Box>
    </Box>
  );
}
