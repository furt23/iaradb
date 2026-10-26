import Box from "@mui/material/Box";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { ViewBar } from "@/features/dashboards/view/ViewBar";
import { authMode } from "@/server/auth/access";
import { currentUser } from "@/server/auth/session";

export const dynamic = "force-dynamic";

/** What viewers see instead of the Studio: a slim bar and the page. Nothing of the workspace is loaded here. */
export default async function ViewLayout({ children }: { children: ReactNode }) {
  // the proxy already sent visitors without a session to sign in; this keeps the page closed if it did not
  const user = await currentUser();
  if (!user) redirect("/auth/login");
  return (
    <Box sx={{ height: "100vh", display: "flex", flexDirection: "column", bgcolor: "background.default" }}>
      <ViewBar email={user.email} signOut={authMode() === "auth0"} />
      <Box component="main" sx={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {children}
      </Box>
    </Box>
  );
}
