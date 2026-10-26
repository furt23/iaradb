import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { createContext } from "react";

/** What the notebook's find bar searches for: editors inside a notebook paint its matches (and leave Ctrl+F to the notebook). */
export const FindContext = createContext<{ regexp: RegExp | null } | null>(null);

export const setFindRegExp = StateEffect.define<RegExp | null>();

const match = Decoration.mark({ class: "cm-findMatch" });
// the match the selection covers is the one the find bar is on
const current = Decoration.mark({ class: "cm-findMatch cm-findCurrent" });

function paint(re: RegExp | null, state: EditorState): DecorationSet {
  if (!re) return Decoration.none;
  const { from, to } = state.selection.main;
  const marks = [...state.doc.toString().matchAll(re)]
    .filter((m) => m[0])
    .map((m) => (m.index === from && m.index + m[0].length === to ? current : match).range(m.index, m.index + m[0].length));
  return Decoration.set(marks);
}

const found = StateField.define<{ re: RegExp | null; marks: DecorationSet }>({
  create: () => ({ re: null, marks: Decoration.none }),
  update(value, tr) {
    const re = tr.effects.reduce<RegExp | null>((r, e) => (e.is(setFindRegExp) ? e.value : r), value.re);
    if (re === value.re && !tr.docChanged && !tr.selection) return value;
    return { re, marks: paint(re, tr.state) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.marks),
});

const theme = EditorView.baseTheme({
  ".cm-findMatch": { backgroundColor: "rgba(224,176,74,0.3)", borderRadius: "2px" },
  ".cm-findCurrent": { backgroundColor: "rgba(224,176,74,0.65)", outline: "1px solid rgba(224,176,74,0.9)" },
});

export const findHighlight = [found, theme];
