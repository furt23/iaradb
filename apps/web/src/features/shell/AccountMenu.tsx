"use client";

import LogoutOutlined from "@mui/icons-material/LogoutOutlined";
import PersonOutline from "@mui/icons-material/PersonOutlined";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useState } from "react";

/** The user the Studio runs as; `signOut` is false when sign-in is off. */
export interface AppAccount {
  name: string;
  email: string;
  admin: boolean;
  picture?: string;
  signOut: boolean;
}

/** "Ana Souza" -> "AS", "ana@x.com" -> "A". */
export function initials(name: string): string {
  const words = name.split("@")[0].split(/[\s._-]+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

/** The account's avatar, with a menu: who is signed in, and signing out. */
export function AccountMenu({ account }: { account: AppAccount }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const local = !account.signOut;
  const label = local ? "Local Studio" : account.name;
  return (
    <>
      <Tooltip title={local ? "Local Studio (sign-in is off)" : account.email}>
        <IconButton onClick={(e) => setAnchor(e.currentTarget)} aria-label="account" sx={{ p: 0.25 }}>
          <Avatar
            src={account.picture}
            alt=""
            sx={{ width: 28, height: 28, fontSize: 12, fontWeight: 600, bgcolor: "primary.main", color: "primary.contrastText" }}
          >
            {local ? <PersonOutline sx={{ fontSize: 18 }} /> : initials(account.name || account.email)}
          </Avatar>
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { minWidth: 240, mt: 0.5 } } }}
      >
        <Box sx={{ px: 1.5, py: 1 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Typography sx={{ fontWeight: 600, fontSize: 13.5 }} noWrap>
              {label}
            </Typography>
            {account.admin && !local && <Chip label="admin" size="small" variant="outlined" sx={{ height: 18, fontSize: 10.5 }} />}
          </Box>
          <Typography variant="body2" sx={{ color: "text.secondary", fontSize: 12.5 }} noWrap>
            {local ? "Sign-in is off on this Studio" : account.email}
          </Typography>
        </Box>
        {account.signOut && <Divider sx={{ my: 0.5 }} />}
        {account.signOut && (
          // a full page load: Auth0 ends the session too
          <MenuItem component="a" href="/auth/logout">
            <ListItemIcon>
              <LogoutOutlined fontSize="small" />
            </ListItemIcon>
            Sign out
          </MenuItem>
        )}
      </Menu>
    </>
  );
}
