import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";

import Box from "@mui/material/Box";
import InitColorSchemeScript from "@mui/material/InitColorSchemeScript";
import { AppRouterCacheProvider } from "@mui/material-nextjs/v16-appRouter";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ComputeProvider } from "@/features/compute/ComputeProvider";
import { NavRail } from "@/features/shell/NavRail";
import { NotifyProvider } from "@/features/shell/notify";
import { ThemeRegistry } from "@/features/shell/ThemeRegistry";
import { WorkspacePanel } from "@/features/shell/WorkspacePanel";
import { Workbench } from "@/features/workbench/Workbench";
import { WorkbenchProvider } from "@/features/workbench/WorkbenchProvider";
import { listTree, type FileNode } from "@/server/workspace/files";
import { workspaceName } from "@/server/workspace/sources";

export const metadata: Metadata = {
  title: "Workhouse Studio",
  description: "Notebooks, SQL and a data catalog on the Workhouse engine",
};

export const dynamic = "force-dynamic";

function notebooksIn(nodes: FileNode[]): string[] {
  return nodes.flatMap((n) => (n.kind === "notebook" ? [n.path] : n.children ? notebooksIn(n.children) : []));
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // read from the Studio's files: no kernel (nor cluster) is needed to draw the shell
  const [tree, name] = await Promise.all([listTree().catch((): FileNode[] => []), workspaceName()]);
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <InitColorSchemeScript attribute="data-scheme" defaultMode="dark" />
        <AppRouterCacheProvider>
          <ThemeRegistry>
            <NotifyProvider>
              <ComputeProvider>
                <WorkbenchProvider>
                  <Box sx={{ display: "flex", height: "100vh", bgcolor: "background.default" }}>
                    <NavRail />
                    <WorkspacePanel name={name} tree={tree} />
                    <Box component="main" sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                      {children}
                      <Workbench notebooks={notebooksIn(tree)} />
                    </Box>
                  </Box>
                </WorkbenchProvider>
              </ComputeProvider>
            </NotifyProvider>
          </ThemeRegistry>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}
