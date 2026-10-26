import { DataView } from "@/features/data/DataView";
import { catalogTables } from "@/server/workspace/catalog";

export const dynamic = "force-dynamic";

/** The Data section: the open tables (or where to start). */
export default async function DataPage() {
  const tables = await catalogTables().catch(() => []);
  return <DataView name={null} tables={tables} />;
}
