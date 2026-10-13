"use client";

import LogoutOutlined from "@mui/icons-material/LogoutOutlined";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";

/** Signs out of the Studio and of Auth0 (a full page load, not client navigation). */
export function SignOutButton({ email }: { email: string }) {
  return (
    <Tooltip title={`Sign out ${email}`} placement="right">
      <IconButton href="/auth/logout" aria-label="sign out" sx={{ width: 40, height: 36, borderRadius: 2, color: "text.secondary" }}>
        <LogoutOutlined fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}
