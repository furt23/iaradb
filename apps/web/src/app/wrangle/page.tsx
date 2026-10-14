import { catalogTables } from "@/server/workspace/catalog";
import { WranglePageContent } from "@/features/wrangler/WranglePageContent";

export const dynamic = "force-dynamic";

/** Visual Data Wrangler page: interactive data preparation and recipe builder. */
export default async function WranglePage() {
  const tables = await catalogTables().catch(() => []);
  return <WranglePageContent tables={tables} />;
}
