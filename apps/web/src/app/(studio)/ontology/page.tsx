import { OntologyView } from "@/features/ontology/OntologyView";
import { ErrorState } from "@/features/shell/PageHeader";
import { ontologyOverviewAction } from "@/server/actions/ontology";

export const dynamic = "force-dynamic";

export default async function OntologyPage() {
  const overview = await ontologyOverviewAction();
  if (!overview.ok) return <ErrorState title="Ontology" message={overview.error.message} />;
  return <OntologyView overview={overview.data} />;
}
