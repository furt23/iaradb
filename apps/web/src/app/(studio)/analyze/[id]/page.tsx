import { AnalysisView } from "@/features/analyze/AnalysisView";
import { ErrorState } from "@/features/shell/PageHeader";
import { getAnalysis } from "@/server/actions/analyze";

export const dynamic = "force-dynamic";

export default async function AnalysisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const analysis = await getAnalysis(decodeURIComponent(id));
  if (!analysis.ok) return <ErrorState title="Analysis" message={analysis.error.message} />;
  return <AnalysisView analysis={analysis.data} />;
}
