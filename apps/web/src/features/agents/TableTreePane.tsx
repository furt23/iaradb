"use client";

import Search from "@mui/icons-material/Search";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import InputAdornment from "@mui/material/InputAdornment";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { useMemo, useState } from "react";

import { SidePanelHeader } from "@/features/shell/SidePanelHeader";
import { useTranslation } from "@/i18n";
import type { AgentTable } from "@/lib/agents/types";

import type { TableInfo } from "./TableDetail";
import { CatalogTreeRow, SchemaTreeRow, TableTreeRow } from "./TableTreeRows";
import { MAX_SHOWN, groupTables, schemaKeyOf, visibleTables } from "./tableTree";

interface Props {
  tables: AgentTable[];
  /** null while the readable tables load */
  readable: string[] | null;
  infos: Record<string, TableInfo>;
  selected: string | null;
  onSelect(name: string): void;
  onIncluded(names: string[], included: boolean): void;
}

/**
 * The tables the agent may read, as a tree by catalog and schema. Schemas open on a click,
 * while filtering, and for the selected table's schema; only the open ones list their tables.
 */
export function TableTreePane({ tables, readable, infos, selected, onSelect, onIncluded }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"all" | "included">("all");
  // a schema's open state, once the user has clicked it (else the default below)
  const [toggles, setToggles] = useState<Record<string, boolean>>({});

  const includedNames = useMemo(() => new Set(tables.filter((x) => x.included).map((x) => x.name)), [tables]);
  const names = useMemo(() => [...(readable ?? []), ...tables.map((x) => x.name)], [readable, tables]);
  const groups = useMemo(
    () => groupTables(names, query, mode === "included" ? includedNames : null),
    [names, query, mode, includedNames],
  );

  const filtering = query.trim() !== "";
  const selectedKey = selected ? schemaKeyOf(selected) : null;
  const isOpen = (key: string) => toggles[key] ?? (filtering || key === selectedKey);
  const { visible, truncated } = visibleTables(groups, isOpen);

  return (
    <>
      <SidePanelHeader
        overline={t("Agent")}
        title={t("Tables")}
        actions={<Typography sx={{ fontSize: 11, color: "text.disabled", flexShrink: 0 }}>{t("{{count}} included", { count: includedNames.size })}</Typography>}
      />
      <Box sx={{ px: 1, py: 1, display: "flex", flexDirection: "column", gap: 1, borderBottom: 1, borderColor: "divider" }}>
        <TextField
          size="small"
          fullWidth
          placeholder={t("Filter tables")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          slotProps={{
            htmlInput: { "aria-label": t("Filter tables") },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <Search sx={{ fontSize: 16 }} />
                </InputAdornment>
              ),
              sx: { fontSize: 13 },
            },
          }}
        />
        <ToggleButtonGroup
          exclusive
          fullWidth
          size="small"
          value={mode}
          onChange={(_, next: "all" | "included" | null) => next && setMode(next)}
          sx={{ "& .MuiToggleButton-root": { fontSize: 12, py: 0.25, textTransform: "none" } }}
        >
          <ToggleButton value="all">{t("All")}</ToggleButton>
          <ToggleButton value="included">{t("Included ({{count}})", { count: includedNames.size })}</ToggleButton>
        </ToggleButtonGroup>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", px: 0.5, py: 0.5 }}>
        {readable === null ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress size={22} />
          </Box>
        ) : groups.length === 0 ? (
          <Typography variant="body2" sx={{ color: "text.secondary", p: 1.5 }}>
            {t("No tables found")}
          </Typography>
        ) : (
          groups.map((c) => (
            <Box key={c.catalog}>
              <CatalogTreeRow name={c.catalog} tables={c.schemas.reduce((n, s) => n + s.tables.length, 0)} />
              {c.schemas.map((s) => {
                const key = `${c.catalog}.${s.schema}`;
                const open = isOpen(key);
                const included = s.tables.filter((name) => includedNames.has(name));
                return (
                  <Box key={key}>
                    <SchemaTreeRow
                      schema={s.schema}
                      tables={s.tables.length}
                      includedCount={included.length}
                      open={open}
                      onToggle={() => setToggles((prev) => ({ ...prev, [key]: !open }))}
                      onIncluded={(on) => onIncluded(s.tables, on)}
                    />
                    {open &&
                      s.tables
                        .filter((name) => visible.has(name))
                        .map((name) => {
                          const info = infos[name];
                          return (
                            <TableTreeRow
                              key={name}
                              name={name}
                              included={includedNames.has(name)}
                              active={name === selected}
                              rows={info?.status === "ready" ? info.numRows : null}
                              onSelect={() => onSelect(name)}
                              onIncluded={(on) => onIncluded([name], on)}
                            />
                          );
                        })}
                  </Box>
                );
              })}
            </Box>
          ))
        )}
        {truncated && (
          <Typography variant="caption" sx={{ display: "block", color: "text.secondary", px: 1.5, py: 1 }}>
            {t("Showing the first {{count}} matches", { count: MAX_SHOWN })}
          </Typography>
        )}
      </Box>
    </>
  );
}
