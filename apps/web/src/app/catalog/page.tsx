import { CatalogList } from "@/features/catalog/CatalogList";
import { listTables } from "@/server/actions/catalog";

export const dynamic = "force-dynamic";

export default async function CatalogPage() {
  const tables = await listTables();
  return <CatalogList tables={tables.ok ? tables.data : []} error={tables.ok ? null : tables.error.message} />;
}
