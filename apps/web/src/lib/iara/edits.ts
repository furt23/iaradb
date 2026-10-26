import type { IaraEdit } from "./protocol";

/**
 * `code` with the edits applied in order, each to the code the previous one
 * left. An edit's `old` must occur exactly once (an empty `old` only fits empty
 * code), so edits written against older code fail instead of landing in the
 * wrong place. Throws with a message for the model that wrote them.
 */
export function applyEdits(code: string, edits: IaraEdit[]): string {
  let out = code;
  edits.forEach((edit, i) => {
    const old = edit.old.replace(/\r\n/g, "\n");
    const next = edit.new.replace(/\r\n/g, "\n");
    const which = edits.length > 1 ? `edit ${i + 1}: ` : "";
    if (!old) {
      if (out.trim()) throw new Error(`${which}old is empty but the code is not; copy the text to replace into old`);
      out = next;
      return;
    }
    const at = out.indexOf(old);
    if (at < 0) throw new Error(`${which}old was not found in the code; copy it exactly from the current code`);
    if (out.indexOf(old, at + 1) >= 0) throw new Error(`${which}old occurs more than once in the code; include the lines around it`);
    out = out.slice(0, at) + next + out.slice(at + old.length);
  });
  return out;
}
