import { WranglePageContent } from "@/features/wrangler/WranglePageContent";
import { catalogTables } from "@/server/workspace/catalog";

export const dynamic = "force-dynamic";

/** The wrangler on a catalog table. */
export default async function WrangleTablePage({ params }: { params: Promise<{ name: string }> }) {
  const [{ name }, tables] = await Promise.all([params, catalogTables().catch(() => [])]);
  return <WranglePageContent table={decodeURIComponent(name)} known={tables.some((t) => t.name === decodeURIComponent(name))} hasTables={tables.length > 0} />;
}
