"use client";

import ContentCopyOutlined from "@mui/icons-material/ContentCopyOutlined";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import { useMemo, type ReactNode } from "react";

import { CodeEditor } from "@/features/editor/CodeEditor";
import { useNotify } from "@/features/shell/notify";
import { useTranslation } from "@/i18n";
import { formatSql } from "@/lib/sqlFormat";

/** SQL to read: formatted, highlighted, with a copy button; `actions` sit beside it. */
export function SqlBlock({ sql, maxHeight = 280, actions }: { sql: string; maxHeight?: number; actions?: ReactNode }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const text = useMemo(() => formatSql(sql), [sql]);
  return (
    <Box sx={{ position: "relative", border: 1, borderColor: "divider", borderRadius: 1, overflow: "hidden", "&:hover .sql-actions": { opacity: 1 } }}>
      <CodeEditor value={text} language="sql" readOnly lineNumbers={false} maxHeight={maxHeight} />
      <Box
        className="sql-actions"
        sx={{ position: "absolute", top: 4, right: 4, display: "flex", gap: 0.5, opacity: 0, transition: "opacity 120ms", "@media (hover: none)": { opacity: 1 }, "&:focus-within": { opacity: 1 } }}
      >
        {actions}
        <Tooltip title={t("Copy SQL")}>
          <IconButton
            size="small"
            aria-label={t("Copy SQL")}
            onClick={() => void navigator.clipboard.writeText(text).then(() => notify(t("Copied"), "success"))}
            sx={{ bgcolor: "background.paper", "&:hover": { bgcolor: "action.hover" } }}
          >
            <ContentCopyOutlined sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
}
