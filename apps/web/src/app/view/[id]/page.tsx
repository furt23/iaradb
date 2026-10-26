import { notFound } from "next/navigation";

import { SharedDashboard } from "@/features/dashboards/view/SharedDashboard";
import { openShared } from "@/server/actions/view";

export const dynamic = "force-dynamic";

/** One shared dashboard; one the user may not open looks like one that is not there. */
export default async function SharedDashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opened = await openShared(id);
  if (!opened.ok) notFound();
  return <SharedDashboard key={id} view={opened.data} />;
}
