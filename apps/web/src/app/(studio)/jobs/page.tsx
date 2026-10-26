import { JobsView } from "@/features/jobs/JobsView";
import { DASHBOARDS_DIR } from "@/server/dashboards/store";
import { listTree, type FileNode } from "@/server/workspace/files";

export const dynamic = "force-dynamic";

/** What a job can run: notebooks and query files (not the datasets of dashboards, which schedule their own refreshes). */
function targetsIn(nodes: FileNode[]): string[] {
  return nodes.flatMap((n) => {
    if (n.kind === "notebook" || n.kind === "sql") return [n.path];
    return n.children && n.path !== DASHBOARDS_DIR ? targetsIn(n.children) : [];
  });
}

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const [params, tree] = await Promise.all([searchParams, listTree().catch((): FileNode[] => [])]);
  return <JobsView targets={targetsIn(tree)} newTarget={params.new ?? null} />;
}
