import { DataView } from "@/features/data/DataView";
import { catalogTables } from "@/server/workspace/catalog";

export const dynamic = "force-dynamic";

/** A catalog table, in its tab. */
export default async function TablePage({ params }: { params: Promise<{ name: string }> }) {
  const [{ name }, tables] = await Promise.all([params, catalogTables().catch(() => [])]);
  return <DataView name={decodeURIComponent(name)} tables={tables} />;
}
