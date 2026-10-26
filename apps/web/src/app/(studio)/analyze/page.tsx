import { AnalyzeIndex } from "@/features/analyze/AnalyzeIndex";
import { ErrorState } from "@/features/shell/PageHeader";
import { catalogSchema } from "@/server/actions/catalog";
import { listAnalyses } from "@/server/actions/analyze";

export const dynamic = "force-dynamic";

export default async function AnalyzePage() {
  const [analyses, schema] = await Promise.all([listAnalyses(), catalogSchema()]);
  if (!analyses.ok) return <ErrorState title="Analyze" message={analyses.error.message} />;
  return <AnalyzeIndex analyses={analyses.data} schema={schema.ok ? schema.data : {}} />;
}
