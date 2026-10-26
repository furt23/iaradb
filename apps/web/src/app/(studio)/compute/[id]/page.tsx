import { ClusterDetail } from "@/features/compute/detail/ClusterDetail";

export const dynamic = "force-dynamic";

export default async function ClusterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ClusterDetail id={decodeURIComponent(id)} />;
}
