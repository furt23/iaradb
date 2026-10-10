import { JobsView } from "@/features/jobs/JobsView";
import { listTree, type FileNode } from "@/server/workspace/files";

export const dynamic = "force-dynamic";

/** What a job can run: notebooks and query files. */
function targetsIn(nodes: FileNode[]): string[] {
  return nodes.flatMap((n) => (n.kind === "notebook" || n.kind === "sql" ? [n.path] : n.children ? targetsIn(n.children) : []));
}

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const [params, tree] = await Promise.all([searchParams, listTree().catch((): FileNode[] => [])]);
  return <JobsView targets={targetsIn(tree)} newTarget={params.new ?? null} />;
}
