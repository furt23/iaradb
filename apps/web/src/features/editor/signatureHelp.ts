import { Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, keymap, showTooltip, ViewPlugin, type Tooltip, type ViewUpdate } from "@codemirror/view";
import type { SignatureHelp } from "@workhouse/protocol";

import type { EditorAssist } from "./assist";

type Fetch = NonNullable<EditorAssist["signature"]>;

interface Shown {
  pos: number;
  help: SignatureHelp;
}

const setSignature = StateEffect.define<Shown | null>();

/** The character just typed (`(` also when bracket closing inserted `()`). */
function typedChar(update: ViewUpdate): string | null {
  let typed: string | null = null;
  update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    typed = fromA === toA && inserted.length >= 1 && inserted.length <= 2 ? inserted.sliceString(0, 1) : null;
  });
  return typed;
}

const signatureField = StateField.define<Shown | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSignature)) value = e.value;
    if (value && tr.docChanged) value = { ...value, pos: tr.changes.mapPos(value.pos) };
    return value;
  },
  provide: (f) => showTooltip.from(f, (v): Tooltip | null => (v ? { pos: v.pos, above: true, create: () => ({ dom: render(v.help) }) } : null)),
});

function firstParagraph(doc: string): string {
  const para = doc.trim().split(/\n\s*\n/)[0] ?? "";
  return para.length > 420 ? `${para.slice(0, 419)}…` : para;
}

function render(help: SignatureHelp): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-signature";
  const line = document.createElement("div");
  line.className = "cm-signature-line";
  line.append(`${help.name}(`);
  help.params.forEach((p, i) => {
    if (i) line.append(", ");
    const span = document.createElement("span");
    span.textContent = p;
    if (i === help.active) span.className = "cm-signature-active";
    line.append(span);
  });
  line.append(")");
  if (help.returns) line.append(` → ${help.returns}`);
  dom.append(line);
  if (help.doc) {
    const doc = document.createElement("div");
    doc.className = "cm-signature-doc";
    doc.textContent = firstParagraph(help.doc);
    dom.append(doc);
  }
  return dom;
}

function plugin(fetch: Fetch) {
  return ViewPlugin.fromClass(
    class {
      private timer = 0;
      private abort: AbortController | null = null;

      constructor(private readonly view: EditorView) {}

      update(u: ViewUpdate) {
        if (!u.docChanged && !u.selectionSet) return;
        const typed = u.docChanged ? typedChar(u) : null;
        if (typed === "(" || typed === ",") this.schedule(0);
        else if (typed === ")") this.schedule(0, true);
        else if (u.state.field(signatureField)) this.schedule(150);
      }

      /** Ask the kernel (`close`: just hide the tooltip). */
      schedule(delay: number, close = false) {
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => void (close ? this.show(null) : this.request()), delay);
      }

      async request() {
        this.abort?.abort();
        const abort = (this.abort = new AbortController());
        const state = this.view.state;
        const pos = state.selection.main.head;
        const help = await fetch(state.doc.toString(), pos, abort.signal).catch(() => null);
        if (abort.signal.aborted || this.view.state.doc !== state.doc) return;
        this.show(help ? { pos, help } : null);
      }

      show(value: Shown | null) {
        if (value || this.view.state.field(signatureField)) this.view.dispatch({ effects: setSignature.of(value) });
      }

      destroy() {
        window.clearTimeout(this.timer);
        this.abort?.abort();
      }
    },
  );
}

/** Signature help: the call's parameters (the current one highlighted) and doc while typing its arguments. */
export function signatureHelp(fetch: Fetch): Extension {
  const help = plugin(fetch);
  return [
    signatureField,
    help,
    Prec.high(
      keymap.of([
        {
          key: "Escape",
          run: (view) => {
            if (!view.state.field(signatureField)) return false;
            view.dispatch({ effects: setSignature.of(null) });
            return true;
          },
        },
        {
          key: "Mod-Shift-Space",
          run: (view) => {
            void view.plugin(help)?.request();
            return true;
          },
        },
      ]),
    ),
  ];
}
