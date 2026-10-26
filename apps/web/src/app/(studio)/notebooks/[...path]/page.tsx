import { ErrorState } from "@/features/shell/PageHeader";
import { OpenNotebook } from "@/features/workbench/OpenNotebook";
import { resolveFileRoute } from "@/server/workspace/fileRoute";

export const dynamic = "force-dynamic";

/** The workbench (root layout) shows the notebook; this route only names it (by id; a path redirects to its id). */
export default async function NotebookPage({ params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const file = await resolveFileRoute("notebooks", path);
  if (!file) return <ErrorState title="Not found" message="There is no notebook at this link. It may have been deleted." />;
  return <OpenNotebook path={file.path} id={file.id} />;
}
