import { HistoryTable } from "@/features/history/HistoryTable";
import { ErrorState } from "@/features/shell/PageHeader";
import { queryHistory } from "@/server/actions/sql";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const history = await queryHistory(1000);
  if (!history.ok) return <ErrorState title="Query history" message={history.error.message} />;
  return <HistoryTable entries={history.data} />;
}
