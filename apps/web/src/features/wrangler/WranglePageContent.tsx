"use client";

import AutoFixHigh from "@mui/icons-material/AutoFixHigh";
import Search from "@mui/icons-material/Search";
import StorageOutlined from "@mui/icons-material/StorageOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import FormControl from "@mui/material/FormControl";
import InputAdornment from "@mui/material/InputAdornment";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import OutlinedInput from "@mui/material/OutlinedInput";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { TableRef } from "@workhouse/protocol";
import { useState } from "react";

import { WranglerView } from "./WranglerView";

export function WranglePageContent({ tables }: { tables: TableRef[] }) {
  const [selectedTable, setSelectedTable] = useState<string>(tables[0]?.name ?? "");
  const [search, setSearch] = useState("");

  const filteredTables = tables.filter((t) => t.name.toLowerCase().includes(search.toLowerCase()) || t.path.toLowerCase().includes(search.toLowerCase()));

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, height: "100%", bgcolor: "background.default" }}>
      {/* Top Header Bar */}
      <Box
        sx={{
          px: 3,
          py: 1.5,
          borderBottom: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 2,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
          <AutoFixHigh sx={{ color: "primary.main", fontSize: 24 }} />
          <Box>
            <Typography variant="h3" sx={{ lineHeight: 1.2 }}>
              Visual Data Wrangler
            </Typography>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              Clean, transform, and reshape tables with live preview and code export
            </Typography>
          </Box>
        </Box>

        {tables.length > 0 && (
          <FormControl size="small" sx={{ minWidth: 240 }}>
            <InputLabel>Active Table</InputLabel>
            <Select value={selectedTable} label="Active Table" onChange={(e) => setSelectedTable(e.target.value)}>
              {tables.map((t) => (
                <MenuItem key={t.name} value={t.name}>
                  {t.name} ({t.format})
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}
      </Box>

      {/* Main Content Area */}
      <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {!selectedTable ? (
          <Box sx={{ p: 4, maxWidth: 800, mx: "auto", width: "100%" }}>
            <Box sx={{ textAlign: "center", mb: 4 }}>
              <Typography variant="h2" sx={{ mb: 1 }}>
                Select a dataset to begin wrangling
              </Typography>
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                Choose any table from your catalog to visually filter, clean, impute missing values, and export code.
              </Typography>
            </Box>

            <TextField
              fullWidth
              size="small"
              placeholder="Search tables..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <Search fontSize="small" sx={{ color: "text.disabled" }} />
                    </InputAdornment>
                  ),
                },
              }}
              sx={{ mb: 2 }}
            />

            <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
              {filteredTables.map((t) => (
                <Card
                  key={t.name}
                  variant="outlined"
                  sx={{
                    cursor: "pointer",
                    "&:hover": { borderColor: "primary.main", bgcolor: "action.hover" },
                    transition: "all 120ms ease",
                  }}
                  onClick={() => setSelectedTable(t.name)}
                >
                  <CardContent sx={{ p: 2 }}>
                    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
                      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                        <StorageOutlined fontSize="small" sx={{ color: "primary.main" }} />
                        <Typography variant="h4">{t.name}</Typography>
                      </Box>
                      <Chip label={t.format} size="small" variant="outlined" />
                    </Box>
                    <Typography variant="mono" noWrap sx={{ color: "text.secondary", fontSize: 11, display: "block" }}>
                      {t.path}
                    </Typography>
                  </CardContent>
                </Card>
              ))}
            </Box>
          </Box>
        ) : (
          <WranglerView key={selectedTable} kernelKey="workspace" source={{ table: selectedTable }} label={selectedTable} height="100%" />
        )}
      </Box>
    </Box>
  );
}
