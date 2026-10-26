"use client";

import ContentCopy from "@mui/icons-material/ContentCopy";
import TerminalOutlined from "@mui/icons-material/TerminalOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Link from "next/link";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { sqlHref } from "@/features/data/links";
import { useNotify } from "@/features/shell/notify";

interface Props {
  open: boolean;
  /** the query the preview ran, and the same query from Python */
  sql: string;
  python: string;
  onClose: () => void;
}

export function ExportDialog({ open, sql, python, onClose }: Props) {
  const { t } = useTranslation();
  const [lang, setLang] = useState<"python" | "sql">("sql");
  const notify = useNotify();
  const code = lang === "python" ? python : sql;

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    notify(t("Copied"), "success");
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>{t("Recipe code")}</DialogTitle>
      <Box sx={{ px: 3, borderBottom: 1, borderColor: "divider" }}>
        <Tabs value={lang} onChange={(_, v) => setLang(v)}>
          <Tab value="sql" label={t("SQL")} />
          <Tab value="python" label={t("Python")} />
        </Tabs>
      </Box>
      <DialogContent sx={{ pt: 2 }}>
        <Box
          component="pre"
          sx={{
            m: 0,
            p: 2,
            borderRadius: 1,
            bgcolor: "action.hover",
            border: 1,
            borderColor: "divider",
            fontFamily: "var(--mono)",
            fontSize: 12,
            lineHeight: 1.5,
            maxHeight: 420,
            overflow: "auto",
            whiteSpace: "pre-wrap",
          }}
        >
          {code}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, justifyContent: "space-between" }}>
        <Box>
          {lang === "sql" && !/\bFROM\s+source(?:\s|\)|;|,|$)/i.test(sql) && (
            <Button variant="outlined" size="small" startIcon={<TerminalOutlined />} component={Link} href={sqlHref(sql)} onClick={onClose}>
              {t("Open in SQL editor")}
            </Button>
          )}
        </Box>
        <Box sx={{ display: "flex", gap: 1 }}>
          <Button onClick={onClose}>{t("Close")}</Button>
          <Button variant="contained" startIcon={<ContentCopy fontSize="small" />} onClick={copy}>
            {t("Copy")}
          </Button>
        </Box>
      </DialogActions>
    </Dialog>
  );
}
