import { linter, type Diagnostic } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";

import type { EditorAssist } from "./assist";

/** Diagnostics from the kernel (syntax errors, undefined names, SQL errors), underlined in the code. */
export function kernelLinter(lint: NonNullable<EditorAssist["lint"]>): Extension {
  let abort: AbortController | null = null;
  return linter(
    async (view): Promise<Diagnostic[]> => {
      abort?.abort();
      const current = (abort = new AbortController());
      const diags = await lint(view.state.doc.toString(), current.signal).catch(() => null);
      if (!diags || current.signal.aborted) return [];
      const len = view.state.doc.length;
      return diags.map((d) => ({
        from: Math.min(d.from, len),
        to: Math.min(Math.max(d.to, d.from), len),
        severity: d.severity,
        message: d.message,
      }));
    },
    { delay: 450 },
  );
}
