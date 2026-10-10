"use client";

import Box from "@mui/material/Box";
import Menu from "@mui/material/Menu";
import { useState } from "react";

import { useGuard } from "@/features/shell/notify";
import { isStopped, pickable, showSearch } from "@/lib/clusterPicker";

import { ClusterDialog } from "./ClusterDialog";
import { useCompute } from "./ComputeProvider";
import { StartClusterButton } from "./picker/ClusterActionButtons";
import { ClusterMenuFooter } from "./picker/ClusterMenuFooter";
import { ClusterMenuItems } from "./picker/ClusterMenuItems";
import { ClusterSearch } from "./picker/ClusterSearch";
import { ClusterTrigger } from "./picker/ClusterTrigger";
import { CurrentClusterCard } from "./picker/CurrentClusterCard";

/**
 * The cluster something runs on: a dropdown showing its state. The menu lists
 * the clusters, starts and terminates them, and creates new ones.
 */
export function ClusterSelect({ value, onSelect, label }: { value: string | null; onSelect(id: string): void | Promise<void>; label: string }) {
  const { overview, refresh } = useCompute();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const guard = useGuard();

  const clusters = pickable(overview?.clusters ?? []);
  const current = clusters.find((c) => c.id === value);
  const cloud = overview?.cloud ?? false;
  const searchable = showSearch(clusters);
  const emptyText = !overview ? "Loading…" : query ? "No cluster matches" : "No clusters yet";

  const openMenu = (el: HTMLElement) => {
    setQuery("");
    setAnchor(el);
  };
  const closeMenu = () => setAnchor(null);
  const choose = (id: string) =>
    void guard(async () => {
      closeMenu();
      await onSelect(id);
      await refresh();
    });

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, minWidth: 0 }}>
      <ClusterTrigger label={label} current={current} loaded={overview !== null} open={anchor !== null} onOpen={openMenu} />
      {current && isStopped(current) && <StartClusterButton cluster={current} />}
      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={closeMenu}
        // with the search field, it takes the focus instead of the selected item
        autoFocus={!searchable}
        slotProps={{ paper: { sx: { width: 360, maxWidth: "calc(100vw - 32px)" } }, list: { dense: true, "aria-label": label } }}
      >
        {current && <CurrentClusterCard cluster={current} cloud={cloud} />}
        {searchable && <ClusterSearch value={query} onChange={setQuery} />}
        <ClusterMenuItems clusters={clusters} query={query} value={value} emptyText={emptyText} onChoose={choose} />
        <ClusterMenuFooter
          cloud={cloud}
          onCreate={() => {
            closeMenu();
            setCreating(true);
          }}
          onManage={closeMenu}
        />
      </Menu>
      {/* outside the menu: it closes when the dialog opens */}
      <ClusterDialog
        open={creating}
        edit={null}
        types={overview?.instanceTypes ?? []}
        onClose={() => setCreating(false)}
        onSaved={() => void refresh()}
      />
    </Box>
  );
}
