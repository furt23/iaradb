"use client";

import DeleteOutlined from "@mui/icons-material/DeleteOutlined";
import EditOutlined from "@mui/icons-material/EditOutlined";
import PlayArrow from "@mui/icons-material/PlayArrow";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { alpha } from "@mui/material/styles";
import { useState } from "react";

import { useTranslation } from "@/i18n";
import type { AgentExample } from "@/lib/agents/types";
import { testExampleAction } from "@/server/actions/agents";

import { SqlBlock } from "./SqlBlock";

type TestResult = Awaited<ReturnType<typeof testExampleAction>>;
type Preview = { columns: { name: string; type: string }[]; rows: unknown[][]; truncated: boolean };

/** rows of a test result shown under the SQL */
const ROWS_SHOWN = 20;

const cellText = (value: unknown) => (value === null ? "null" : typeof value === "object" ? JSON.stringify(value) : String(value));

/** One example: its question, its SQL, and a test run of that SQL. The test result is kept only for the SQL it ran. */
export function ExampleRow({ slug, example, onEdit, onDelete }: { slug: string; example: AgentExample; onEdit(): void; onDelete(): void }) {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [tested, setTested] = useState<{ sql: string; result: TestResult } | null>(null);
  const result = tested?.sql === example.sql ? tested.result : null;
  const hasSql = example.sql.trim() !== "";

  const run = async () => {
    const sql = example.sql;
    setRunning(true);
    const r = await testExampleAction(slug, sql);
    setTested({ sql, result: r });
    setRunning(false);
  };

  return (
    <Box
      sx={{
        px: 3,
        py: 1.5,
        borderBottom: 1,
        borderColor: "divider",
        "&:hover .row-actions, &:focus-within .row-actions": { opacity: 1 },
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
        <Box
          sx={{
            width: 22,
            height: 22,
            borderRadius: 1,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            fontWeight: 700,
            color: "primary.main",
            bgcolor: (theme) => alpha(theme.palette.primary.main, 0.1),
          }}
        >
          Q
        </Box>
        <Typography sx={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, overflowWrap: "anywhere" }}>{example.question}</Typography>
        <Box className="row-actions" sx={{ display: "flex", gap: 0.5, alignItems: "center", opacity: 0, transition: "opacity 120ms", "@media (hover: none)": { opacity: 1 } }}>
          <Tooltip title={t("Test query")}>
            <span>
              <IconButton size="small" aria-label={t("Test query")} disabled={running || !hasSql} onClick={() => void run()}>
                <PlayArrow fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <IconButton size="small" aria-label={t("Edit")} onClick={onEdit}>
            <EditOutlined fontSize="small" />
          </IconButton>
          <IconButton size="small" aria-label={t("Delete")} onClick={onDelete}>
            <DeleteOutlined fontSize="small" />
          </IconButton>
        </Box>
        {result === null ? (
          <Chip size="small" variant="outlined" label={t("Not tested")} />
        ) : result.ok ? (
          <Chip size="small" variant="outlined" color="success" label={t("SQL works")} />
        ) : (
          <Chip size="small" variant="outlined" color="error" label={t("SQL failed")} />
        )}
      </Box>
      <Box sx={{ mt: 1, pl: "34px" }}>
        {hasSql ? (
          <SqlBlock sql={example.sql} maxHeight={320} />
        ) : (
          <Typography variant="caption" sx={{ color: "text.disabled" }}>
            {t("No SQL yet")}
          </Typography>
        )}
        {result &&
          (result.ok ? (
            <ResultPreview {...result.data} />
          ) : (
            <Alert severity="error" variant="outlined" sx={{ mt: 1 }}>
              {result.error.message}
            </Alert>
          ))}
      </Box>
    </Box>
  );
}

function ResultPreview({ columns, rows, truncated }: Preview) {
  const { t } = useTranslation();
  const shown = rows.slice(0, ROWS_SHOWN);
  return (
    <Box sx={{ mt: 1 }}>
      <Typography variant="caption" sx={{ display: "block", color: "text.secondary" }}>
        {shown.length === 0 ? t("No rows returned") : t("{{count}} rows", { count: shown.length })}
        {truncated && ` · ${t("More rows not shown")}`}
      </Typography>
      <TableContainer sx={{ maxHeight: 240, mt: 0.5, border: 1, borderColor: "divider", borderRadius: 1 }}>
        <Table size="small" stickyHeader sx={{ "& .MuiTableCell-root": { fontSize: 12, py: 0.5, px: 1, whiteSpace: "nowrap" } }}>
          <TableHead>
            <TableRow>
              {columns.map((c, i) => (
                <TableCell key={i} sx={{ fontWeight: 600 }}>
                  {c.name}
                  <Box component="span" sx={{ ml: 0.75, fontWeight: 400, color: "text.secondary" }}>
                    {c.type}
                  </Box>
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {shown.map((row, i) => (
              <TableRow key={i} hover>
                {row.map((cell, j) => (
                  <TableCell key={j} sx={{ fontFamily: "monospace" }}>
                    {cellText(cell)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}
