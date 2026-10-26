import { SqlWorkbench } from "@/features/sql/SqlWorkbench";
import { catalogSchema } from "@/server/actions/catalog";

export const dynamic = "force-dynamic";

export default async function SqlPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const [{ q }, schema] = await Promise.all([searchParams, catalogSchema()]);
  return <SqlWorkbench initialQuery={q ?? "select 1 as hello"} schema={schema.ok ? schema.data : {}} />;
}
