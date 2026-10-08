import { OpenNotebook } from "@/features/workbench/OpenNotebook";

export const dynamic = "force-dynamic";

/** The workbench (root layout) shows the notebook; this route only names it. */
export default async function NotebookPage({ params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return <OpenNotebook path={path.map(decodeURIComponent).join("/")} />;
}
