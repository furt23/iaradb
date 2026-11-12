"use client";

import ChevronRightOutlined from "@mui/icons-material/ChevronRightOutlined";
import ExpandMoreOutlined from "@mui/icons-material/ExpandMoreOutlined";
import SearchOutlined from "@mui/icons-material/SearchOutlined";
import Box from "@mui/material/Box";
import InputAdornment from "@mui/material/InputAdornment";
import MenuItem from "@mui/material/MenuItem";
import MenuList from "@mui/material/MenuList";
import Popover from "@mui/material/Popover";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Dataset } from "@/lib/dashboards/types";
import { typeLabel } from "@/lib/format";

import { fieldChoices, type Choice, type Picked } from "./fieldChoices";
import { buildFieldTree, typeGlyph } from "./fieldTree";
import type { FoundColumns } from "./useDatasetColumns";
import { useModel } from "./useModel";

/** past this many datasets the list starts closed: their names are what is read first */
const OPEN_UP_TO = 5;
const GLYPH = { fontFamily: "var(--font-mono, monospace)", fontSize: 10.5, minWidth: 24, textAlign: "center", color: "text.disabled", flexShrink: 0 } as const;

function List({ datasets, found, values, onPick }: { datasets: Dataset[]; found: FoundColumns; values: boolean; onPick(picked: Picked): void }) {
  const { t } = useTranslation();
  const model = useModel();
  const [query, setQuery] = useState("");
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const list = useRef<HTMLUListElement>(null);
  const groups = useMemo(() => fieldChoices(buildFieldTree({ datasets, model, found, query }), query, { values, rows: t("Rows") }), [datasets, model, found, query, values, t]);
  const searching = query.trim() !== "";
  const startsOpen = groups.length <= OPEN_UP_TO;
  // a search shows what it found; otherwise a click on a dataset flips how it started
  const isOpen = (name: string) => searching || startsOpen !== toggled.has(name);
  const first = groups.flatMap((g) => g.choices)[0];

  const flip = (name: string) =>
    setToggled((now) => {
      const next = new Set(now);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  const row = (c: Choice) => (
    <MenuItem key={c.key} dense onClick={() => onPick(c.picked)} sx={{ gap: 0.5, pl: 2.5 }}>
      <Box component="span" title={c.type && typeLabel(c.type)} sx={GLYPH}>
        {c.picked.kind === "measure" ? "ƒx" : c.picked.kind === "rows" ? "#" : c.type ? typeGlyph(c.type) : ""}
      </Box>
      <Typography noWrap sx={{ fontSize: 13, ...(c.picked.kind === "rows" && { fontStyle: "italic" }), ...(c.picked.kind === "measure" && { color: "primary.main" }) }}>
        {c.label}
      </Typography>
    </MenuItem>
  );

  return (
    <>
      <Box sx={{ p: 1, borderBottom: 1, borderColor: "divider" }}>
        <TextField
          autoFocus
          size="small"
          fullWidth
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("Search fields")}
          onKeyDown={(e) => {
            if (e.key === "Enter" && first) onPick(first.picked);
            if (e.key === "ArrowDown") {
              e.preventDefault();
              list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
            }
          }}
          slotProps={{
            htmlInput: { "aria-label": t("Search fields") },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchOutlined fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
        />
      </Box>
      <MenuList ref={list} dense sx={{ maxHeight: 320, overflow: "auto", py: 0.5 }}>
        {groups.length === 0 && <Typography sx={{ px: 2, py: 1, fontSize: 13, color: "text.secondary" }}>{t("No results")}</Typography>}
        {groups.flatMap((g) => {
          const open = isOpen(g.name);
          return [
            <MenuItem key={`h:${g.name}`} dense aria-expanded={open} onClick={() => flip(g.name)} sx={{ gap: 0.5, pl: 0.75 }}>
              {open ? <ExpandMoreOutlined sx={{ fontSize: 18 }} /> : <ChevronRightOutlined sx={{ fontSize: 18 }} />}
              <Typography noWrap sx={{ fontSize: 13, fontWeight: 650 }}>
                {g.name || t("Measures")}
              </Typography>
            </MenuItem>,
            ...(open ? g.choices.map(row) : []),
            ...(open && g.loading
              ? [
                  <Typography key={`l:${g.name}`} sx={{ pl: 5, py: 0.5, fontSize: 12, color: "text.secondary" }}>
                    {t("Loading")}
                  </Typography>,
                ]
              : []),
          ];
        })}
      </MenuList>
    </>
  );
}

/** The fields to pick from, searchable, by dataset. `values`: a value can also be a measure or a dataset's row count. */
export function FieldPicker({ anchor, datasets, found, values, onPick, onClose }: { anchor: HTMLElement | null; datasets: Dataset[]; found: FoundColumns; values: boolean; onPick(picked: Picked): void; onClose(): void }) {
  return (
    <Popover open={anchor !== null} anchorEl={anchor} onClose={onClose} anchorOrigin={{ vertical: "bottom", horizontal: "left" }} slotProps={{ paper: { sx: { width: 300 } } }}>
      {/* mounted per opening: each search starts empty */}
      {anchor && (
        <List
          datasets={datasets}
          found={found}
          values={values}
          onPick={(picked) => {
            onClose();
            onPick(picked);
          }}
        />
      )}
    </Popover>
  );
}
