import { ErrorState } from "@/features/shell/PageHeader";
import { OpenNotebook } from "@/features/workbench/OpenNotebook";
import { resolveFileRoute } from "@/server/workspace/fileRoute";

export const dynamic = "force-dynamic";

/** The workbench (root layout) shows the SQL file; this route only names it (by id; a path redirects to its id). */
export default async function QueryPage({ params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const file = await resolveFileRoute("queries", path);
  if (!file) return <ErrorState title="Not found" message="There is no query at this link. It may have been deleted." />;
  return <OpenNotebook path={file.path} id={file.id} />;
}
