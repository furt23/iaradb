"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useRouter } from "next/navigation";

import { unwrap } from "@/lib/action";
import { setDefaultCluster } from "@/server/actions/clusters";

import { ClusterSelect } from "./ClusterSelect";
import { useCompute } from "./ComputeProvider";

/** The side panel's default cluster: the SQL editor, the catalog and new notebooks run there. */
export function DefaultClusterChip() {
  const { overview } = useCompute();
  const router = useRouter();
  const current = overview?.clusters.find((c) => c.isDefault)?.id ?? null;
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, px: 1.5, py: 0.5, borderBottom: 1, borderColor: "divider" }}>
      <Typography variant="overline" sx={{ color: "text.disabled", fontSize: 10, lineHeight: 1, flexShrink: 0 }}>
        Default
      </Typography>
      <ClusterSelect
        label="default cluster"
        value={current}
        onSelect={async (id) => {
          unwrap(await setDefaultCluster(id));
          router.refresh();
        }}
      />
    </Box>
  );
}
