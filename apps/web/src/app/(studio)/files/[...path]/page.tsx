import { FileViewer } from "@/features/files/FileViewer";
import { ErrorState } from "@/features/shell/PageHeader";
import { readWorkspaceFile } from "@/server/actions/workspace";

export const dynamic = "force-dynamic";

export default async function FilePage({ params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const rel = path.map(decodeURIComponent).join("/");
  const file = await readWorkspaceFile(rel);
  if (!file.ok) return <ErrorState title={rel} message={file.error.message} />;
  return <FileViewer path={rel} text={file.data.text} truncated={file.data.truncated} />;
}
