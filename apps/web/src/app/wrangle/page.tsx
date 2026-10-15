import { WranglePageContent } from "@/features/wrangler/WranglePageContent";
import { catalogTables } from "@/server/workspace/catalog";

export const dynamic = "force-dynamic";

/** The wrangler before a table is picked in the catalog. */
export default async function WranglePage() {
  const tables = await catalogTables().catch(() => []);
  return <WranglePageContent table={null} known={false} hasTables={tables.length > 0} />;
}
