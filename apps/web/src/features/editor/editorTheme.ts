import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { accents, fonts, night, paper } from "@iara/ui";

/** A diagnostic's range: a clear wavy underline and a faint tint. */
function lintRange(color: string, tint: string) {
  return {
    backgroundImage: "none",
    backgroundColor: tint,
    textDecoration: `underline wavy ${color}`,
    textDecorationThickness: "1.5px",
    textUnderlineOffset: "3px",
    textDecorationSkipInk: "none",
  };
}

/** CodeMirror theme in the Observatory palette (dark or light). */
export function editorTheme(mode: "dark" | "light"): Extension {
  const dark = mode === "dark";
  const base = dark ? night : paper;
  const view = EditorView.theme(
    {
      "&": { backgroundColor: "transparent", color: base.text, fontSize: "13px" },
      ".cm-content": { fontFamily: fonts.mono, caretColor: dark ? accents.ochre : accents.ochreInk, padding: "6px 0" },
      ".cm-gutters": { backgroundColor: "transparent", color: base.textFaint, border: "none" },
      ".cm-activeLine": { backgroundColor: dark ? "rgba(79,179,156,0.06)" : "rgba(47,111,98,0.05)" },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: base.textDim },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
        backgroundColor: dark ? "rgba(79,179,156,0.22)" : "rgba(47,111,98,0.18)",
      },
      ".cm-cursor": { borderLeftColor: dark ? accents.ochre : accents.ochreInk, borderLeftWidth: "2px" },
      "&.cm-focused": { outline: "none" },
      // above the page and its dialogs (the tooltips float in the document body)
      ".cm-tooltip": { backgroundColor: base.raised, border: `1px solid ${base.line}`, color: base.text, zIndex: 1500 },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: dark ? "rgba(224,176,74,0.25)" : "rgba(168,122,21,0.18)", color: base.text },
      ".cm-matchingBracket": { backgroundColor: dark ? "rgba(224,176,74,0.25)" : "rgba(168,122,21,0.2)", outline: "none" },
      ".cm-placeholder": { color: base.textFaint },
      ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: fonts.mono, fontSize: "12.5px", maxHeight: "18em" },
      ".cm-completionDetail": { color: base.textFaint, fontStyle: "normal", marginLeft: "1em" },
      ".cm-completionInfo": { maxWidth: "440px", padding: "8px 10px" },
      ".cm-assist-signature, .cm-signature-line": { fontFamily: fonts.mono, fontSize: "12px", color: base.text, whiteSpace: "pre-wrap" },
      ".cm-assist-doc, .cm-signature-doc": {
        marginTop: "6px",
        fontSize: "12px",
        color: base.textDim,
        whiteSpace: "pre-wrap",
        maxHeight: "16em",
        overflow: "auto",
      },
      ".cm-signature": { padding: "6px 10px", maxWidth: "560px" },
      ".cm-signature-active": { color: dark ? accents.ochre : accents.ochreInk, fontWeight: "700", textDecoration: "underline" },
      ".cm-lintRange-error": lintRange(dark ? "#FF6B6B" : "#D32F2F", dark ? "rgba(255,107,107,0.12)" : "rgba(211,47,47,0.08)"),
      ".cm-lintRange-warning": lintRange(dark ? "#F5C46B" : "#B7801A", dark ? "rgba(245,196,107,0.10)" : "rgba(183,128,26,0.08)"),
      ".cm-lintRange-info": lintRange(dark ? accents.cobalt : accents.cobaltInk, "transparent"),
      ".cm-lintPoint:after": { borderBottomColor: dark ? "#FF6B6B" : "#D32F2F" },
      ".cm-tooltip-lint": { padding: 0 },
      ".cm-diagnostic": { fontFamily: fonts.mono, fontSize: "12px", padding: "4px 10px", whiteSpace: "pre-wrap", maxWidth: "560px" },
      // a change Iara proposes (@codemirror/merge): its own tints are too faint to read as a diff
      "&.cm-merge-b .cm-changedLine": { backgroundColor: dark ? "rgba(46,160,67,0.16)" : "rgba(46,160,67,0.12)" },
      "&.cm-merge-b .cm-changedText": { background: dark ? "rgba(46,160,67,0.35)" : "rgba(46,160,67,0.28)" },
      ".cm-deletedChunk": { backgroundColor: dark ? "rgba(248,81,73,0.14)" : "rgba(248,81,73,0.10)" },
      ".cm-deletedChunk .cm-deletedText": { background: dark ? "rgba(248,81,73,0.35)" : "rgba(248,81,73,0.25)" },
    },
    { dark },
  );
  const c = dark
    ? { kw: "#C792EA", str: "#9CE3B2", num: "#F5C46B", fn: accents.cobalt, type: "#7FD1E8", comment: night.textFaint, op: "#89DDFF", def: accents.ochre }
    : { kw: "#7B30C2", str: "#1F7A4D", num: "#B7801A", fn: accents.cobaltInk, type: "#0E7490", comment: paper.textFaint, op: "#0F5DA8", def: accents.ochreInk };
  const highlight = HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.moduleKeyword], color: c.kw },
    { tag: [t.string, t.special(t.string), t.regexp], color: c.str },
    { tag: [t.number, t.bool, t.null], color: c.num },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: c.fn },
    { tag: [t.typeName, t.className, t.namespace], color: c.type },
    { tag: [t.comment, t.lineComment, t.blockComment], color: c.comment, fontStyle: "italic" },
    { tag: [t.operator, t.punctuation], color: c.op },
    { tag: [t.definition(t.variableName), t.definition(t.function(t.variableName))], color: c.def },
    { tag: t.heading, color: c.def, fontWeight: "700" },
    { tag: [t.emphasis], fontStyle: "italic" },
    { tag: [t.strong], fontWeight: "700" },
    { tag: [t.link, t.url], color: c.fn, textDecoration: "underline" },
  ]);
  return [view, syntaxHighlighting(highlight)];
}
