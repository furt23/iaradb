import type { AgentRating } from "@/lib/agents/types";
import { rateAgentLogAction } from "@/server/actions/agents";

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Rates a logged answer (`note` undefined: its note stays). A rating right after the answer can land before the answer is in the log, so it is tried once more. */
export async function rateEntry(slug: string, id: string, rating: AgentRating | null, note?: string) {
  const r = await rateAgentLogAction(slug, id, rating, note);
  if (r.ok) return r;
  await wait(1000);
  return rateAgentLogAction(slug, id, rating, note);
}
