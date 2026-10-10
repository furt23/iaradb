"use client";

import Memory from "@mui/icons-material/Memory";
import Refresh from "@mui/icons-material/Refresh";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import Link from "next/link";

const NEEDS_CLUSTER = new Set(["NoCluster", "ClusterNotRunning"]);

/** Why something about a table could not be loaded, with the way out. */
export function LoadFailure({ type, message, onRetry }: { type: string; message: string; onRetry?(): void }) {
  const cluster = NEEDS_CLUSTER.has(type);
  return (
    <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 1, alignItems: "flex-start" }}>
      <Typography variant={cluster ? "body2" : "mono"} component="pre" sx={{ m: 0, whiteSpace: "pre-wrap", color: cluster ? "text.secondary" : "error.main" }}>
        {cluster ? `Reading a table runs on the default cluster: ${message}` : message}
      </Typography>
      <Box sx={{ display: "flex", gap: 1 }}>
        {cluster && (
          <Button size="small" variant="outlined" startIcon={<Memory />} component={Link} href="/compute">
            Compute
          </Button>
        )}
        {onRetry && (
          <Button size="small" startIcon={<Refresh />} onClick={onRetry}>
            Retry
          </Button>
        )}
      </Box>
    </Box>
  );
}
