import { GitPanel } from "@/features/git/GitPanel";
import { gitLog, gitStatus } from "@/server/actions/git";

export const dynamic = "force-dynamic";

export default async function GitPage() {
  const [status, log] = await Promise.all([gitStatus(), gitLog()]);
  return <GitPanel status={status.ok ? status.data : null} error={status.ok ? null : status.error.message} log={log.ok ? log.data : []} />;
}
