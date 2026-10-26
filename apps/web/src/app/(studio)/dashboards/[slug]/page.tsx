import { DashboardEditor } from "@/features/dashboards/editor/DashboardEditor";

export const dynamic = "force-dynamic";

export default async function DashboardPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <DashboardEditor slug={decodeURIComponent(slug)} />;
}
