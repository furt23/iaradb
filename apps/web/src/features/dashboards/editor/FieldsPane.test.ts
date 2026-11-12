import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FieldsPane } from "./FieldsPane";
import { FormulaBar } from "./FormulaBar";
import type { MeasureActions } from "./useMeasureActions";

const actions: MeasureActions = { usedBy: () => [], add: () => Promise.resolve(), save: () => Promise.resolve(), remove: () => Promise.resolve() };
const formula = { target: null, openNew: () => undefined, openEdit: () => undefined, select: () => undefined, close: () => undefined };
const datasets = [{ name: "orders", sql: "", params: {} }];

describe("the Fields pane and the formula bar", () => {
  it("draws the pane with its search, its measure button and the datasets closed", () => {
    const markup = renderToStaticMarkup(
      createElement(FieldsPane, { datasets, found: {}, load: () => Promise.resolve([]), widget: undefined, onChange: () => undefined, formula, actions }),
    );
    expect(markup).toContain('aria-label="Fields"');
    expect(markup).toContain('aria-label="Search fields"');
    expect(markup).toContain('aria-label="New measure"');
    expect(markup).toContain('aria-label="Hide fields"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Actions for orders"');
  });

  it("draws the formula bar with its cancel and save buttons", () => {
    const markup = renderToStaticMarkup(
      createElement(FormulaBar, { target: { mode: "new", key: 1 }, datasets, found: {}, load: () => Promise.resolve([]), actions, onClose: () => undefined }),
    );
    expect(markup).toContain('aria-label="Formula bar"');
    expect(markup).toContain('aria-label="Cancel"');
    expect(markup).toContain('aria-label="Add"');
  });
});
