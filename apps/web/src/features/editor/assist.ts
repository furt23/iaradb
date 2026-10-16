import type { Completions, Diagnostic, SignatureHelp } from "@iara/protocol";

/**
 * Code assistance an editor can ask for: computed elsewhere (the notebook's
 * kernel), so each call gets the current code and cursor offset. Returning
 * null means "nothing" (or a stale answer).
 */
export interface EditorAssist {
  complete?(code: string, cursor: number, signal: AbortSignal): Promise<Completions | null>;
  signature?(code: string, cursor: number, signal: AbortSignal): Promise<SignatureHelp | null>;
  lint?(code: string, signal: AbortSignal): Promise<Diagnostic[] | null>;
}
