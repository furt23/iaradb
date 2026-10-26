/** How full the conversation's context is, 0 to 100 (a budget of 0 is empty). */
export function contextPercent(context: number, budget: number): number {
  if (budget <= 0) return 0;
  return Math.min(100, Math.max(0, (context / budget) * 100));
}
