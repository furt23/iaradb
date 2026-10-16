"use client";

import Search from "@mui/icons-material/Search";
import Box from "@mui/material/Box";
import FormControlLabel from "@mui/material/FormControlLabel";
import InputAdornment from "@mui/material/InputAdornment";
import MenuItem from "@mui/material/MenuItem";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import { useTranslation } from "react-i18next";

import type { ClusterFilter } from "@/lib/clusterFilter";

/** Search, state toggle, owner and job switch above the cluster list. */
export function ClusterFilters({
  filter,
  onChange,
  counts,
  owners,
}: {
  filter: ClusterFilter;
  onChange: (f: ClusterFilter) => void;
  counts: { all: number; running: number; stopped: number };
  owners: string[];
}) {
  const { t } = useTranslation();
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap" }}>
      <TextField
        size="small"
        value={filter.query}
        onChange={(e) => onChange({ ...filter, query: e.target.value })}
        placeholder={t("Search clusters")}
        slotProps={{
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <Search fontSize="small" />
              </InputAdornment>
            ),
          },
        }}
        sx={{ flex: 1, minWidth: 200, maxWidth: 360 }}
      />
      <ToggleButtonGroup
        size="small"
        exclusive
        value={filter.state}
        onChange={(_, v: ClusterFilter["state"] | null) => v && onChange({ ...filter, state: v })}
        aria-label={t("Cluster state")}
      >
        <ToggleButton value="all">{t("All ({{n}})", { n: counts.all })}</ToggleButton>
        <ToggleButton value="running">{t("Running ({{n}})", { n: counts.running })}</ToggleButton>
        <ToggleButton value="stopped">{t("Stopped ({{n}})", { n: counts.stopped })}</ToggleButton>
      </ToggleButtonGroup>
      {owners.length > 0 && (
        <TextField
          select
          size="small"
          label={t("Owner")}
          value={filter.owner ?? ""}
          onChange={(e) => onChange({ ...filter, owner: e.target.value || null })}
          sx={{ minWidth: 180 }}
        >
          <MenuItem value="">{t("Anyone")}</MenuItem>
          {owners.map((o) => (
            <MenuItem key={o} value={o}>
              {o}
            </MenuItem>
          ))}
        </TextField>
      )}
      <FormControlLabel
        control={<Switch size="small" checked={filter.jobs} onChange={(_, v) => onChange({ ...filter, jobs: v })} />}
        label={t("Job clusters")}
      />
    </Box>
  );
}
