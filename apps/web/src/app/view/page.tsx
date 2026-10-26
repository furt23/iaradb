import { SharedList } from "@/features/dashboards/view/SharedList";
import { listShared } from "@/server/actions/view";

export const dynamic = "force-dynamic";

/** The dashboards shared with the signed-in user. */
export default async function ViewPage() {
  const shared = await listShared();
  return shared.ok ? <SharedList items={shared.data} /> : <SharedList items={[]} error={shared.error.message} />;
}
