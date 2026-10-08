"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { CellOutput, ErrorOutput, StreamChunk } from "@workhouse/protocol";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { TableOutputView } from "./TableOutputView";

export function ErrorView({ output }: { output: ErrorOutput }) {
  return (
    <Box sx={{ px: 2, py: 1.25, borderLeft: 3, borderColor: "error.main", bgcolor: "action.hover" }}>
      <Typography variant="mono" component="div" sx={{ color: "error.main", fontWeight: 700, whiteSpace: "pre-wrap" }}>
        {output.ename}: {output.evalue}
      </Typography>
      {output.traceback && (
        <Typography variant="mono" component="pre" sx={{ m: 0, mt: 1, color: "text.secondary", whiteSpace: "pre-wrap", fontSize: 11.5 }}>
          {output.traceback}
        </Typography>
      )}
    </Box>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <Box
      sx={{
        px: 2,
        py: 0.5,
        "& h1, & h2, & h3": { mt: 1, mb: 0.5, letterSpacing: "-0.01em" },
        "& p": { my: 0.75, lineHeight: 1.6 },
        "& code": { fontFamily: "'JetBrains Mono Variable', monospace", fontSize: "0.85em", px: 0.5, borderRadius: 0.5, bgcolor: "action.hover" },
        "& a": { color: "primary.main" },
        "& table": { borderCollapse: "collapse" },
        "& td, & th": { border: 1, borderColor: "divider", px: 1, py: 0.25 },
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </Box>
  );
}

export function Streams({ streams }: { streams: StreamChunk[] }) {
  if (!streams.length) return null;
  return (
    <Box component="pre" sx={{ m: 0, px: 2, py: 1, fontFamily: "'JetBrains Mono Variable', monospace", fontSize: 12, whiteSpace: "pre-wrap", maxHeight: 320, overflow: "auto" }}>
      {streams.map((s, i) => (
        <Box component="span" key={i} sx={{ color: s.stream === "stderr" ? "warning.main" : "text.primary" }}>
          {s.text}
        </Box>
      ))}
    </Box>
  );
}

/** Render any cell output. HTML from user code runs in a script-less sandbox. */
export function OutputView({ output, kernelKey, tableHeight }: { output: CellOutput; kernelKey: string; tableHeight?: number }) {
  switch (output.type) {
    case "table":
      return <TableOutputView output={output} kernelKey={kernelKey} height={tableHeight} />;
    case "text":
      return (
        <Typography variant="mono" component="pre" sx={{ m: 0, px: 2, py: 1, whiteSpace: "pre-wrap" }}>
          {output.text}
        </Typography>
      );
    case "markdown":
      return <Markdown text={output.text} />;
    case "html":
      return <Box component="iframe" sandbox="" srcDoc={output.html} title="output" sx={{ width: "100%", minHeight: 160, border: 0, bgcolor: "#fff", borderRadius: 1 }} />;
    case "image":
      return (
        <Box sx={{ px: 2, py: 1 }}>
          <Box component="img" src={`data:${output.mime};base64,${output.data}`} alt="cell output" sx={{ maxWidth: "100%" }} />
        </Box>
      );
    case "error":
      return <ErrorView output={output} />;
  }
}
