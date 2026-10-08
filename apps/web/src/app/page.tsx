import { HomeView } from "@/features/home/HomeView";
import { queryHistory } from "@/server/actions/sql";
import { workspaceInfo } from "@/server/actions/workspace";
import { listTree, type FileNode } from "@/server/workspace/files";

export const dynamic = "force-dynamic";

function notebooksIn(nodes: FileNode[]): string[] {
  return nodes.flatMap((n) => (n.kind === "notebook" ? [n.path] : n.children ? notebooksIn(n.children) : []));
}

export default async function HomePage() {
  const [info, history, tree] = await Promise.all([workspaceInfo(), queryHistory(20), listTree().catch(() => [])]);
  return (
    <HomeView
      info={info.ok ? info.data : null}
      infoError={info.ok ? null : info.error.message}
      notebooks={notebooksIn(tree)}
      history={history.ok ? history.data : []}
    />
  );
}
