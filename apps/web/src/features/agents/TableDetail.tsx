"use client";

import TableChartOutlined from "@mui/icons-material/TableChartOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

import { useTranslation } from "@/i18n";
import type { AgentTable } from "@/lib/agents/types";

import { SectionHeader, SectionLayout } from "./AgentSection";

/** What the catalog says about a table, once read. */
export type TableInfo =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; columns: { name: string; type: string }[]; numRows: number | null };

/** The selected table: its header, its description and what each column means. */
export function TableDetail({
  table,
  info,
  onChange,
  onIncluded,
}: {
  table: AgentTable;
  info: TableInfo | undefined;
  onChange(next: AgentTable): void;
  onIncluded(included: boolean): void;
}) {
  const { t } = useTranslation();
  const setColumn = (column: string, text: string) => {
    const columns = { ...table.columns };
    if (text === "") delete columns[column];
    else columns[column] = text;
    onChange({ ...table, columns });
  };
  const ready = info?.status === "ready" ? info : null;

  const header = (
    <SectionHeader
      icon={<TableChartOutlined />}
      title={table.name}
      subtitle={
        <Chip
          component="span"
          size="small"
          variant="outlined"
          color={table.included ? "success" : "default"}
          label={table.included ? t("Included") : t("Left out")}
          sx={{ height: 20, fontSize: 11, mt: 0.5 }}
        />
      }
      stats={[
        { label: t("Rows"), value: ready?.numRows == null ? "–" : ready.numRows.toLocaleString() },
        { label: t("Columns"), value: ready ? String(ready.columns.length) : "–" },
      ]}
      actions={
        <Button variant="outlined" onClick={() => onIncluded(!table.included)}>
          {table.included ? t("Leave out") : t("Include")}
        </Button>
      }
    />
  );

  return (
    <SectionLayout header={header}>
      <Box sx={{ borderBottom: 1, borderColor: "divider" }}>
        <TextField
          multiline
          minRows={2}
          fullWidth
          variant="standard"
          placeholder={t("What the table holds and how to use it")}
          value={table.note}
          onChange={(e) => onChange({ ...table, note: e.target.value })}
          slotProps={{
            htmlInput: { "aria-label": t("Description") },
            input: { disableUnderline: true, sx: { px: 3, py: 1.5, fontSize: 13 } },
          }}
        />
      </Box>
      {!info || info.status === "loading" ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
          <CircularProgress size={22} />
        </Box>
      ) : info.status === "error" ? (
        <Alert severity="error" sx={{ m: 2 }}>
          {t("Could not read the columns of {{name}}: {{error}}", { name: table.name, error: info.message })}
        </Alert>
      ) : info.columns.length === 0 ? (
        <Typography variant="body2" sx={{ color: "text.secondary", p: 3 }}>
          {t("{{name}} has no columns.", { name: table.name })}
        </Typography>
      ) : (
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell>{t("Column")}</TableCell>
              <TableCell>{t("Type")}</TableCell>
              <TableCell>{t("Description")}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {info.columns.map((col) => (
              <TableRow key={col.name} hover>
                <TableCell sx={{ fontFamily: "monospace", fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" }}>{col.name}</TableCell>
                <TableCell sx={{ fontFamily: "monospace", fontSize: 11.5, color: "text.secondary", whiteSpace: "nowrap" }}>{col.type}</TableCell>
                <TableCell sx={{ p: 0.5, minWidth: 160, width: "100%" }}>
                  <TextField
                    variant="standard"
                    fullWidth
                    multiline
                    placeholder={t("Add a description")}
                    value={table.columns[col.name] ?? ""}
                    onChange={(e) => setColumn(col.name, e.target.value)}
                    slotProps={{
                      htmlInput: { "aria-label": `${t("Description")} ${col.name}` },
                      input: { disableUnderline: true, sx: { px: 1, py: 0.5, fontSize: 12.5 } },
                    }}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionLayout>
  );
}
