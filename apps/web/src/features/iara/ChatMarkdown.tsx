"use client";

import CheckRounded from "@mui/icons-material/CheckRounded";
import ContentCopyRounded from "@mui/icons-material/ContentCopyRounded";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import { isValidElement, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { CodeEditor } from "@/features/editor/CodeEditor";
import { useTranslation } from "@/i18n";

/** A python or sql block in the notebook's own editor, read only, with a copy button. */
function CodeBlock({ code, language }: { code: string; language: "python" | "sql" }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // no clipboard access: the icon stays as it is
    }
  };

  return (
    <Box sx={{ my: 0.75, border: 1, borderColor: "divider", borderRadius: 1, overflow: "hidden" }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", px: 1, py: 0.25, borderBottom: 1, borderColor: "divider", bgcolor: "action.hover" }}>
        <Typography variant="caption" sx={{ fontFamily: "monospace", color: "text.secondary" }}>
          {language}
        </Typography>
        <IconButton size="small" aria-label={t("Copy")} onClick={() => void copy()} sx={{ p: 0.5 }}>
          {copied ? <CheckRounded sx={{ fontSize: 14 }} /> : <ContentCopyRounded sx={{ fontSize: 14 }} />}
        </IconButton>
      </Box>
      <CodeEditor value={code} language={language} readOnly lineNumbers={false} maxHeight={320} />
    </Box>
  );
}

// links open beside the Studio: leaving it would drop the conversation on screen
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  // other languages keep the plain block
  pre: ({ children }) => {
    const code = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children.props : undefined;
    const lang = /language-(\w+)/.exec(code?.className ?? "")?.[1];
    const language = lang === "python" || lang === "py" ? "python" : lang === "sql" ? "sql" : null;
    if (!code || !language) return <pre>{children}</pre>;
    return <CodeBlock code={String(code.children ?? "").replace(/\n$/, "")} language={language} />;
  },
};

/** Iara's reply as markdown, sized for the narrow panel; `size` is the text size (a thought is smaller). */
export function ChatMarkdown({ text, size = 14 }: { text: string; size?: number }) {
  return (
    <Box
      sx={{
        fontSize: size,
        lineHeight: 1.6,
        overflowWrap: "anywhere",
        "& > :first-of-type": { mt: 0 },
        "& > :last-child": { mb: 0 },
        "& p, & ul, & ol": { my: 0.75 },
        "& h1, & h2, & h3, & h4": { fontSize: 15, mt: 1.5, mb: 0.5, letterSpacing: "-0.01em" },
        "& a": { color: "primary.main" },
        "& pre": { m: 0, my: 0.75, p: 1, borderRadius: 1, bgcolor: "action.hover", overflowX: "auto", fontSize: 12.5, lineHeight: 1.5 },
        "& :not(pre) > code": { px: 0.5, borderRadius: 0.5, bgcolor: "action.hover", fontSize: "0.85em" },
        "& table": { display: "block", overflowX: "auto", borderCollapse: "collapse" },
        "& td, & th": { border: 1, borderColor: "divider", px: 1, py: 0.25 },
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </Box>
  );
}
