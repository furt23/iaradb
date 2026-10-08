import { TableDetail } from "@/features/catalog/TableDetail";
import { ErrorState } from "@/features/shell/PageHeader";
import { previewTable, tableInfo } from "@/server/actions/catalog";

export const dynamic = "force-dynamic";

export default async function TablePage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const table = decodeURIComponent(name);
  const [info, preview] = await Promise.all([tableInfo(table), previewTable(table)]);
  if (!info.ok) return <ErrorState title={`Table ${table}`} message={info.error.message} />;
  return <TableDetail info={info.data} preview={preview.ok ? preview.data : null} />;
}
