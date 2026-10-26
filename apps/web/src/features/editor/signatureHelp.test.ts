import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { SignatureHelp } from "@iara/protocol";
import { describe, expect, it } from "vitest";

import { firstParagraph, setSignature, signatureField, signatureHelp } from "./signatureHelp";

const sampleHelp: SignatureHelp = {
  name: "read_parquet",
  params: ["path: str", "storage_options: StorageOptions | null = None"],
  active: 0,
  returns: "DataFrame",
  doc: "Read a parquet file.\n\nExtra details here.",
};

describe("signatureHelp", () => {
  describe("firstParagraph", () => {
    it("extracts the first paragraph and ignores subsequent ones", () => {
      const doc = "First paragraph here.\n\nSecond paragraph here.\nThird line.";
      expect(firstParagraph(doc)).toBe("First paragraph here.");
    });

    it("truncates paragraphs longer than 420 characters with an ellipsis", () => {
      const long = "a".repeat(500);
      const res = firstParagraph(long);
      expect(res.length).toBe(420);
      expect(res.endsWith("…")).toBe(true);
    });

    it("handles empty documentation strings", () => {
      expect(firstParagraph("")).toBe("");
      expect(firstParagraph("   ")).toBe("");
    });
  });

  describe("signatureField", () => {
    it("initializes to null", () => {
      const state = EditorState.create({
        extensions: [signatureField],
      });
      expect(state.field(signatureField)).toBeNull();
    });

    it("updates when setSignature effect is dispatched", () => {
      const state = EditorState.create({
        doc: "read_parquet()",
        extensions: [signatureField],
      });

      const updated = state.update({
        effects: setSignature.of({ pos: 12, help: sampleHelp }),
      }).state;

      expect(updated.field(signatureField)).toEqual({
        pos: 12,
        help: sampleHelp,
      });

      const cleared = updated.update({
        effects: setSignature.of(null),
      }).state;

      expect(cleared.field(signatureField)).toBeNull();
    });

    it("tracks position shifts when the document changes", () => {
      const state = EditorState.create({
        doc: "read_parquet()",
        extensions: [signatureField],
      });

      const withSig = state.update({
        effects: setSignature.of({ pos: 12, help: sampleHelp }),
      }).state;

      // Insert "iara." at position 0
      const shifted = withSig.update({
        changes: { from: 0, insert: "iara." },
      }).state;

      expect(shifted.field(signatureField)?.pos).toBe(12 + 5);
    });
  });

  describe("focusChangeEffect", () => {
    it("clears signatureField when editor loses focus", () => {
      const extensions = signatureHelp(async () => sampleHelp);
      const state = EditorState.create({
        doc: "read_parquet()",
        extensions: [extensions],
      });

      const withSig = state.update({
        effects: setSignature.of({ pos: 12, help: sampleHelp }),
      }).state;

      expect(withSig.field(signatureField)).not.toBeNull();

      // Look up focusChangeEffect facet
      const focusEffects = withSig.facet(EditorView.focusChangeEffect);
      expect(focusEffects.length).toBeGreaterThan(0);

      // When blurring (focusing = false), the effect should return setSignature.of(null)
      const effects = focusEffects
        .map((fn) => fn(withSig, false))
        .filter((e): e is NonNullable<typeof e> => e !== null);

      expect(effects.length).toBe(1);
      expect(effects[0]?.is(setSignature)).toBe(true);
      expect(effects[0]?.value).toBeNull();

      // Applying that effect clears the field
      const blurred = withSig.update({ effects }).state;
      expect(blurred.field(signatureField)).toBeNull();

      // When already null, blurring should not produce redundant effects
      const noEffects = focusEffects
        .map((fn) => fn(blurred, false))
        .filter((e): e is NonNullable<typeof e> => e !== null);
      expect(noEffects.length).toBe(0);
    });
  });
});

