/**
 * Server actions return `ActionResult`s instead of throwing: errors thrown
 * from actions are redacted by Next.js in production, and the Studio needs
 * their messages (SQL errors, missing files, Git failures ...).
 */

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: { type: string; message: string } };

export async function attempt<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    const err = e as Error & { type?: string };
    return { ok: false, error: { type: err.type ?? err.name ?? "Error", message: err.message ?? String(e) } };
  }
}
