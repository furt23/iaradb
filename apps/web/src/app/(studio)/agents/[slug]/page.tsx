import { AgentBuilder } from "@/features/agents/AgentBuilder";

export const dynamic = "force-dynamic";

export default async function AgentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <AgentBuilder slug={decodeURIComponent(slug)} />;
}
