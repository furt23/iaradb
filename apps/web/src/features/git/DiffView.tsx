"use client";

import Box from "@mui/material/Box";

function lineColor(line: string): string | undefined {
  if (line.startsWith("+++") || line.startsWith("---")) return "text.secondary";
  if (line.startsWith("+")) return "success.main";
  if (line.startsWith("-")) return "error.main";
  if (line.startsWith("@@")) return "primary.main";
  return undefined;
}

/** A unified diff, colored per line. */
export function DiffView({ diff }: { diff: string }) {
  const lines = diff.replace(/\n$/, "").split("\n");
  return (
    <Box component="pre" sx={{ m: 0, p: 1.5, fontFamily: "'JetBrains Mono Variable', monospace", fontSize: 12, lineHeight: 1.55, overflow: "auto" }}>
      {lines.map((line, i) => (
        <Box
          key={i}
          sx={{
            color: lineColor(line),
            bgcolor: line.startsWith("+") && !line.startsWith("+++") ? "rgba(95,211,166,0.08)" : line.startsWith("-") && !line.startsWith("---") ? "rgba(242,119,122,0.08)" : undefined,
            whiteSpace: "pre",
          }}
        >
          {line || " "}
        </Box>
      ))}
    </Box>
  );
}
