"use client";

import Add from "@mui/icons-material/Add";
import SettingsOutlined from "@mui/icons-material/SettingsOutlined";
import Divider from "@mui/material/Divider";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Link from "next/link";

/** The picker's last items: create a cluster, or go to the Compute page. */
export function ClusterMenuFooter({ cloud, onCreate, onManage }: { cloud: boolean; onCreate(): void; onManage(): void }) {
  return (
    <>
      <Divider />
      <MenuItem disabled={!cloud} onClick={onCreate}>
        <ListItemIcon>
          <Add fontSize="small" />
        </ListItemIcon>
        <ListItemText primary="Create cluster…" secondary={cloud ? undefined : "AWS not configured"} />
      </MenuItem>
      <MenuItem component={Link} href="/compute" onClick={onManage}>
        <ListItemIcon>
          <SettingsOutlined fontSize="small" />
        </ListItemIcon>
        Manage clusters…
      </MenuItem>
    </>
  );
}
