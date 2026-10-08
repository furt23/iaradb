"use client";

import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";

import { CodeEditor, type EditorLanguage } from "@/features/editor/CodeEditor";
import { PageBody, PageHeader } from "@/features/shell/PageHeader";

function languageOf(path: string): EditorLanguage {
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".sql")) return "sql";
  return "markdown";
}

/** Read-only view of a workspace text file. */
export function FileViewer({ path, text, truncated }: { path: string; text: string; truncated: boolean }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <PageHeader title={path.split("/").pop()} subtitle={path} />
      <PageBody>
        {truncated && <Typography sx={{ color: "warning.main", mb: 1 }}>Showing the first megabyte of this file.</Typography>}
        <Paper variant="outlined" sx={{ overflow: "hidden" }}>
          <CodeEditor value={text} language={languageOf(path)} readOnly />
        </Paper>
      </PageBody>
    </Box>
  );
}
