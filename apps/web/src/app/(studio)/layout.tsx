import Box from "@mui/material/Box";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { ComputeProvider } from "@/features/compute/ComputeProvider";
import { CatalogPanel } from "@/features/data/CatalogPanel";
import { DataProvider } from "@/features/data/DataProvider";
import { AccountProvider } from "@/features/shell/account";
import { AppBar } from "@/features/shell/AppBar";
import { NavRail } from "@/features/shell/NavRail";
import { QuickOpen } from "@/features/shell/QuickOpen";
import { ShellProvider } from "@/features/shell/ShellProvider";
import { SidePanel } from "@/features/shell/SidePanel";
import { WorkspacePanel } from "@/features/shell/WorkspacePanel";
import { idsOfTree } from "@/features/workbench/fileIdRegistry";
import { Workbench } from "@/features/workbench/Workbench";
import { WorkbenchProvider } from "@/features/workbench/WorkbenchProvider";
import { authMode } from "@/server/auth/access";
import { currentUser } from "@/server/auth/session";
import { catalogList, catalogSchemas, catalogTables } from "@/server/workspace/catalog";
import { listTree, type FileNode } from "@/server/workspace/files";
import { workspaceName } from "@/server/workspace/sources";

export const dynamic = "force-dynamic";

/** The files the workbench opens: notebooks and SQL queries. */
function workbenchFiles(nodes: FileNode[]): string[] {
  return nodes.flatMap((n) =>
    n.kind === "notebook" || n.kind === "sql"
      ? [n.path]
      : n.children
        ? workbenchFiles(n.children)
        : [],
  );
}

/** The Studio shell: file tree, catalog and workbench around every Studio page. Viewers never get here. */
export default async function StudioLayout({
  children,
}: {
  children: ReactNode;
}) {
  // the proxy already sent visitors without a session to sign in; this keeps the workspace hidden if it did not
  const user = await currentUser();
  if (!user) redirect("/auth/login");
  if (user.viewer) redirect("/view");
  const account = {
    name: user.name,
    email: user.email,
    admin: user.admin,
    picture: user.picture,
    signOut: authMode() === "auth0",
  };
  // read from the Studio's files: no kernel (nor cluster) is needed to draw the shell
  // (the catalog and file list are read on every render: router.refresh() updates them)
  const [tree, name, catalog, schemas, catalogs] = await Promise.all([
    listTree().catch((): FileNode[] => []),
    workspaceName(),
    catalogTables().then(
      (tables) => ({ tables, error: null }),
      (e: Error) => ({ tables: [], error: e.message }),
    ),
    catalogSchemas().catch(() => []),
    catalogList().catch(() => []),
  ]);
  return (
    <AccountProvider account={account}>
      <ComputeProvider>
        <ShellProvider>
          <WorkbenchProvider ids={idsOfTree(tree)}>
            <DataProvider>
              <Box
                sx={{
                  display: "flex",
                  flexDirection: "column",
                  height: "100vh",
                  bgcolor: "background.default",
                }}
              >
                <AppBar workspace={name} account={account} />
                <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>
                  <NavRail />
                  <SidePanel
                    panels={{
                      files: <WorkspacePanel name={name} tree={tree} />,
                      catalog: (
                        <CatalogPanel
                          tables={catalog.tables}
                          schemas={schemas}
                          catalogs={catalogs}
                          error={catalog.error}
                        />
                      ),
                    }}
                  />
                  <Box
                    component="main"
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      display: "flex",
                      flexDirection: "column",
                      overflow: "hidden",
                    }}
                  >
                    {children}
                    <Workbench
                      name={name}
                      notebooks={workbenchFiles(tree)}
                    />
                  </Box>
                </Box>
              </Box>
              <QuickOpen
                files={workbenchFiles(tree)}
                tables={catalog.tables}
              />
            </DataProvider>
          </WorkbenchProvider>
        </ShellProvider>
      </ComputeProvider>
    </AccountProvider>
  );
}
