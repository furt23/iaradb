import { autocompletion, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { globalCompletion, localCompletionSource } from "@codemirror/lang-python";
import type { Extension } from "@codemirror/state";
import type { CompletionItem } from "@iara/protocol";

import type { EditorAssist } from "./assist";

function infoNode(item: CompletionItem): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-assist-info";
  if (item.signature) {
    const sig = document.createElement("div");
    sig.className = "cm-assist-signature";
    sig.textContent = item.signature;
    dom.append(sig);
  }
  if (item.doc) {
    const doc = document.createElement("div");
    doc.className = "cm-assist-doc";
    doc.textContent = item.doc;
    dom.append(doc);
  }
  return dom;
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function toCompletion(item: CompletionItem): Completion {
  return {
    label: item.label,
    type: item.type,
    detail: item.detail ? shorten(item.detail, 56) : undefined,
    info: item.signature || item.doc ? () => infoNode(item) : undefined,
    // jedi's order puts private and dunder names last; keep it
    boost: item.label.startsWith("__") ? -2 : item.label.startsWith("_") ? -1 : 0,
  };
}

/** Python's own (static) completions, when the kernel has nothing to say. */
async function fallback(ctx: CompletionContext): Promise<CompletionResult | null> {
  const results = [localCompletionSource(ctx), await globalCompletion(ctx)].filter((r): r is CompletionResult => r !== null);
  if (!results.length) return null;
  return { from: Math.min(...results.map((r) => r.from)), options: results.flatMap((r) => r.options), validFor: /^\w*$/ };
}

function kernelSource(complete: NonNullable<EditorAssist["complete"]>): CompletionSource {
  return async (ctx) => {
    const word = ctx.matchBefore(/\w+$/);
    const member = ctx.matchBefore(/\.\w*$/);
    if (!ctx.explicit && !word && !member) return null;
    const abort = new AbortController();
    ctx.addEventListener("abort", () => abort.abort());
    const r = await complete(ctx.state.doc.toString(), ctx.pos, abort.signal).catch(() => null);
    if (ctx.aborted) return null;
    if (!r || !r.items.length) return member ? null : fallback(ctx);
    return { from: r.from, options: r.items.map(toCompletion), validFor: /^\w*$/ };
  };
}

/** Autocompletion from the kernel (jedi over the cell and the notebook's values). */
export function kernelCompletion(complete: NonNullable<EditorAssist["complete"]>): Extension {
  return autocompletion({ override: [kernelSource(complete)], activateOnTypingDelay: 60, maxRenderedOptions: 200 });
}
